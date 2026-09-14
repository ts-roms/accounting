import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import { DIMENSION_TYPES, type DimensionType } from '@accounting/types';
import type {
  CreateDimensionInput,
  DimensionRefs,
  ListDimensionsQuery,
  UpdateDimensionInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { dimensions, type Dimension } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'ACCOUNTING';
const OUTER_ID = sql.raw('"dimensions"."id"');
const OUTER_PARENT = sql.raw('"dimensions"."parent_id"');

const FIELD_TYPE: Record<keyof DimensionRefs, DimensionType> = {
  departmentId: 'DEPARTMENT',
  costCenterId: 'COST_CENTER',
  projectId: 'PROJECT',
};

export interface DimensionView extends Dimension {
  parentCode: string | null;
  usageCount: number;
}

/**
 * Departments, cost centers and projects. Every module that writes a line with
 * dimension references calls `validateRefs` inside its transaction so a line
 * can never point at an inactive, foreign or mistyped dimension.
 */
@Injectable()
export class DimensionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(companyId: string, query: ListDimensionsQuery): Promise<DimensionView[]> {
    const filters: SQL[] = [eq(dimensions.companyId, companyId)];
    if (query.dimensionType) filters.push(eq(dimensions.dimensionType, query.dimensionType));
    if (query.status) filters.push(eq(dimensions.status, query.status));
    return this.db
      .select({
        ...getTableColumns(dimensions),
        parentCode: sql<
          string | null
        >`(select p.code from dimensions p where p.id = ${OUTER_PARENT})`,
        usageCount: sql<number>`(select count(*)::int from journal_lines l where l.department_id = ${OUTER_ID} or l.cost_center_id = ${OUTER_ID} or l.project_id = ${OUTER_ID})`,
      })
      .from(dimensions)
      .where(and(...filters))
      .orderBy(asc(dimensions.dimensionType), asc(dimensions.code));
  }

  async get(companyId: string, id: string): Promise<DimensionView> {
    const rows = await this.list(companyId, {});
    const row = rows.find((d) => d.id === id);
    if (!row) throw new NotFoundError('Dimension', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateDimensionInput,
  ): Promise<DimensionView> {
    const id = await this.db.transaction(async (tx) => {
      await this.assertParent(tx, companyId, input.dimensionType, input.parentId);
      if (input.startDate && input.endDate && input.endDate < input.startDate) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'End date cannot precede the start date.',
        );
      }
      try {
        const [row] = await tx
          .insert(dimensions)
          .values({
            companyId,
            dimensionType: input.dimensionType,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            parentId: input.parentId ?? null,
            startDate: input.startDate ?? null,
            endDate: input.endDate ?? null,
            managerUserId: input.managerUserId ?? null,
          })
          .returning();
        await this.audit.record(
          {
            action: 'CREATE',
            module: MODULE,
            entityType: 'Dimension',
            entityId: row!.id,
            newValue: { type: input.dimensionType, code: input.code, name: input.name },
            metadata: { actor: actor.email },
            companyId,
          },
          tx,
        );
        return row!.id;
      } catch (err) {
        if (isUniqueViolation(err, 'dimensions_company_type_code_uq'))
          throw new DuplicateError(input.dimensionType, 'code', input.code);
        throw err;
      }
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateDimensionInput,
  ): Promise<DimensionView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(dimensions)
        .where(and(eq(dimensions.id, id), eq(dimensions.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Dimension', id);
      if (input.parentId !== undefined) {
        if (input.parentId === id)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'A dimension cannot be its own parent.',
          );
        await this.assertParent(tx, companyId, existing.dimensionType, input.parentId);
      }
      const startDate = input.startDate === undefined ? existing.startDate : input.startDate;
      const endDate = input.endDate === undefined ? existing.endDate : input.endDate;
      if (startDate && endDate && endDate < startDate) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'End date cannot precede the start date.',
        );
      }
      await tx
        .update(dimensions)
        .set({
          name: input.name ?? existing.name,
          description: input.description === undefined ? existing.description : input.description,
          parentId: input.parentId === undefined ? existing.parentId : input.parentId,
          startDate,
          endDate,
          managerUserId:
            input.managerUserId === undefined ? existing.managerUserId : input.managerUserId,
          status: input.status ?? existing.status,
        })
        .where(eq(dimensions.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Dimension',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status },
          newValue: input,
          metadata: { actor: actor.email, code: existing.code },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Checks every dimension reference on a set of lines: exists in the company,
   * is ACTIVE, has the type the column implies and (projects) is within its dates.
   */
  async validateRefs(
    tx: DbExecutor,
    companyId: string,
    refs: readonly DimensionRefs[],
    asOf?: string,
  ): Promise<void> {
    const wanted = new Map<string, DimensionType>();
    for (const ref of refs) {
      for (const field of Object.keys(FIELD_TYPE) as Array<keyof DimensionRefs>) {
        const id = ref[field];
        if (id) wanted.set(id, FIELD_TYPE[field]);
      }
    }
    if (wanted.size === 0) return;
    const rows = await tx
      .select()
      .from(dimensions)
      .where(and(eq(dimensions.companyId, companyId), inArray(dimensions.id, [...wanted.keys()])));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [id, expected] of wanted) {
      const row = byId.get(id);
      if (!row) throw new NotFoundError('Dimension', id);
      if (row.dimensionType !== expected) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `${row.code} is a ${label(row.dimensionType)}, not a ${label(expected)}.`,
        );
      }
      if (row.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `${label(row.dimensionType)} ${row.code} is inactive.`,
        );
      if (
        asOf &&
        ((row.startDate && asOf < row.startDate) || (row.endDate && asOf > row.endDate))
      ) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `${label(row.dimensionType)} ${row.code} is not open on ${asOf}.`,
        );
      }
    }
  }

  private async assertParent(
    tx: DbExecutor,
    companyId: string,
    type: DimensionType,
    parentId: string | null | undefined,
  ): Promise<void> {
    if (!parentId) return;
    const [parent] = await tx
      .select()
      .from(dimensions)
      .where(and(eq(dimensions.id, parentId), eq(dimensions.companyId, companyId)));
    if (!parent) throw new NotFoundError('Dimension', parentId);
    if (parent.dimensionType !== type)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'A parent must be of the same dimension type.',
      );
  }
}

function label(type: DimensionType): string {
  return DIMENSION_TYPES.includes(type) ? type.toLowerCase().replace('_', ' ') : type;
}
