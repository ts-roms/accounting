import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { PaginatedResult } from '@accounting/types';
import type {
  CreateEmployeeInput,
  EmployeePayItemInput,
  ListEmployeesQuery,
  UpdateEmployeeInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  dimensions,
  employeePayItems,
  employees,
  payItems,
  users,
  type Employee,
  type EmployeePayItem,
} from '@/database/schema';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'PAYROLL';

export interface EmployeeView extends Employee {
  fullName: string;
  departmentName: string | null;
  userEmail: string | null;
}

export interface EmployeePayItemView extends EmployeePayItem {
  payItemCode: string;
  payItemName: string;
  payItemType: string;
}

export interface EmployeeDetail extends EmployeeView {
  payItems: EmployeePayItemView[];
}

/**
 * Employee master (Prompt #11). Employees are payroll master data - never
 * users: an optional `userId` link is what lets expense claims of that user
 * be reimbursed through a pay run. Pay assignments are effective-dated so a
 * run picks up exactly what applied in its period.
 */
@Injectable()
export class EmployeesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly dimensions: DimensionsService,
  ) {}

  async list(companyId: string, query: ListEmployeesQuery): Promise<PaginatedResult<EmployeeView>> {
    const filters: SQL[] = [eq(employees.companyId, companyId)];
    if (query.status) filters.push(eq(employees.status, query.status));
    if (query.payFrequency) filters.push(eq(employees.payFrequency, query.payFrequency));
    if (query.departmentId) filters.push(eq(employees.departmentId, query.departmentId));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(employees.employeeNumber, term),
          ilike(employees.firstName, term),
          ilike(employees.lastName, term),
          ilike(employees.email, term),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(
          query.sortBy === 'name'
            ? query.sortDir === 'desc'
              ? desc(employees.lastName)
              : asc(employees.lastName)
            : asc(employees.employeeNumber),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, employees, where),
    ]);
    return toPaginatedResult(rows.map(toView), total, query);
  }

  async get(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<EmployeeDetail> {
    const [row] = await this.viewQuery(executor).where(
      and(eq(employees.companyId, companyId), eq(employees.id, id)),
    );
    if (!row) throw new NotFoundError('Employee', id);
    const items = await executor
      .select({
        a: employeePayItems,
        payItemCode: payItems.code,
        payItemName: payItems.name,
        payItemType: payItems.type,
      })
      .from(employeePayItems)
      .innerJoin(payItems, eq(payItems.id, employeePayItems.payItemId))
      .where(eq(employeePayItems.employeeId, id))
      .orderBy(asc(employeePayItems.effectiveFrom), asc(payItems.sortOrder));
    return {
      ...toView(row),
      payItems: items.map((i) => ({
        ...i.a,
        payItemCode: i.payItemCode,
        payItemName: i.payItemName,
        payItemType: i.payItemType,
      })),
    };
  }

  async getOrThrow(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Employee> {
    const [row] = await executor
      .select()
      .from(employees)
      .where(and(eq(employees.companyId, companyId), eq(employees.id, id)));
    if (!row) throw new NotFoundError('Employee', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateEmployeeInput,
  ): Promise<EmployeeDetail> {
    const id = await this.db.transaction(async (tx) => {
      await this.dimensions.validateRefs(tx, companyId, [input], input.hireDate);
      if (input.userId) await this.assertUserFree(tx, companyId, input.userId, null);
      const employeeNumber =
        input.employeeNumber ??
        (await this.numbering.allocate(companyId, 'EMP', Number(input.hireDate.slice(0, 4)), tx));
      const [clash] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(eq(employees.companyId, companyId), eq(employees.employeeNumber, employeeNumber)),
        );
      if (clash) throw new DuplicateError('Employee', 'employeeNumber', employeeNumber);
      const [created] = await tx
        .insert(employees)
        .values({
          companyId,
          employeeNumber,
          userId: input.userId ?? null,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          jobTitle: input.jobTitle ?? null,
          employmentType: input.employmentType,
          payFrequency: input.payFrequency,
          baseSalary: input.baseSalary,
          hireDate: input.hireDate,
          terminationDate: input.terminationDate ?? null,
          status: input.terminationDate ? 'TERMINATED' : 'ACTIVE',
          branchId: input.branchId ?? null,
          departmentId: input.departmentId ?? null,
          costCenterId: input.costCenterId ?? null,
          projectId: input.projectId ?? null,
          taxIdentificationNumber: input.taxIdentificationNumber ?? null,
          paymentMethod: input.paymentMethod,
          bankName: input.bankName ?? null,
          bankAccountNumber: input.bankAccountNumber ?? null,
          notes: input.notes ?? null,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Employee',
          entityId: created!.id,
          newValue: {
            employeeNumber,
            name: `${input.firstName} ${input.lastName}`,
            payFrequency: input.payFrequency,
            baseSalary: input.baseSalary,
          },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateEmployeeInput,
  ): Promise<EmployeeDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(companyId, id, tx);
      const { changeReason, ...rest } = input;
      const patch: Partial<Employee> = {};
      for (const [k, v] of Object.entries(rest))
        if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      const merged = { ...existing, ...patch };
      if (merged.terminationDate && merged.terminationDate < merged.hireDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Termination cannot precede the hire date.',
        );
      if (input.terminationDate && input.status === undefined) patch.status = 'TERMINATED';
      if (
        input.terminationDate === null &&
        existing.status === 'TERMINATED' &&
        input.status === undefined
      )
        patch.status = 'ACTIVE';
      await this.dimensions.validateRefs(tx, companyId, [merged], merged.hireDate);
      if (patch.userId) await this.assertUserFree(tx, companyId, patch.userId, id);
      const [updated] = await tx
        .update(employees)
        .set(patch)
        .where(eq(employees.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Employee',
          entityId: id,
          previousValue: previous,
          newValue: next,
          metadata: { reason: changeReason ?? null, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async addPayItem(
    companyId: string,
    actor: AuthenticatedUser,
    employeeId: string,
    input: EmployeePayItemInput,
  ): Promise<EmployeeDetail> {
    await this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, employeeId, tx);
      const [item] = await tx
        .select()
        .from(payItems)
        .where(and(eq(payItems.companyId, companyId), eq(payItems.id, input.payItemId)));
      if (!item) throw new NotFoundError('Pay item', input.payItemId);
      if (item.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.PAY_ITEM_INVALID,
          `Pay item ${item.code} is inactive.`,
        );
      if (item.calculation === 'BASE_SALARY')
        throw new BusinessRuleError(
          ErrorCodes.PAY_ITEM_INVALID,
          'The base salary item applies to every employee automatically.',
        );
      const [created] = await tx
        .insert(employeePayItems)
        .values({
          employeeId,
          payItemId: input.payItemId,
          amount: input.amount ?? null,
          rate: input.rate ?? null,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Employee',
          entityId: employeeId,
          previousValue: { payItem: item.code, assigned: false },
          newValue: {
            payItem: item.code,
            assigned: true,
            amount: input.amount ?? null,
            rate: input.rate ?? null,
            effectiveFrom: input.effectiveFrom,
          },
          metadata: { reason: 'pay item assigned', assignmentId: created!.id, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, employeeId);
  }

  async removePayItem(
    companyId: string,
    actor: AuthenticatedUser,
    employeeId: string,
    assignmentId: string,
  ): Promise<EmployeeDetail> {
    await this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, employeeId, tx);
      const [row] = await tx
        .delete(employeePayItems)
        .where(
          and(eq(employeePayItems.id, assignmentId), eq(employeePayItems.employeeId, employeeId)),
        )
        .returning();
      if (!row) throw new NotFoundError('Pay item assignment', assignmentId);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Employee',
          entityId: employeeId,
          previousValue: { assignmentId, payItemId: row.payItemId, assigned: true },
          newValue: { assignmentId, payItemId: row.payItemId, assigned: false },
          metadata: { reason: 'pay item removed', editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, employeeId);
  }

  // ---------------------------------------------------------------- internals

  private async assertUserFree(
    tx: DbExecutor,
    companyId: string,
    userId: string,
    selfId: string | null,
  ) {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!user) throw new NotFoundError('User', userId);
    const [taken] = await tx
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), eq(employees.userId, userId)));
    if (taken && taken.id !== selfId) throw new DuplicateError('Employee', 'userId', userId);
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        e: employees,
        departmentName: dimensions.name,
        userEmail: users.email,
        fullName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
      })
      .from(employees)
      .leftJoin(dimensions, eq(dimensions.id, employees.departmentId))
      .leftJoin(users, eq(users.id, employees.userId))
      .$dynamic();
  }
}

function toView(row: {
  e: Employee;
  departmentName: string | null;
  userEmail: string | null;
  fullName: string;
}): EmployeeView {
  return {
    ...row.e,
    fullName: row.fullName,
    departmentName: row.departmentName,
    userEmail: row.userEmail,
  };
}
