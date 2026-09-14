import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { OPEN_DOCUMENT_STATUSES, type PaginatedResult } from '@accounting/types';
import type {
  CreateVendorInput,
  ListPartiesQuery,
  UpdateVendorInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { vendorPayments, vendors, vendorBills, type Vendor } from '@/database/schema';

const MODULE = 'PAYABLES';

export interface VendorBalance {
  /** Open bills/debit notes not yet settled. */
  outstanding: string;
  /** Portion of `outstanding` past its due date (as of today). */
  overdue: string;
  /** Unapplied credit notes plus unallocated receipts (net of refunds). */
  unappliedCredit: string;
  /** outstanding - unappliedCredit */
  net: string;
}

export interface VendorView extends Vendor {
  balance: VendorBalance;
}

@Injectable()
export class VendorsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  async list(companyId: string, query: ListPartiesQuery): Promise<PaginatedResult<VendorView>> {
    const filters: SQL[] = [eq(vendors.companyId, companyId)];
    if (query.status) filters.push(eq(vendors.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(ilike(vendors.code, term), ilike(vendors.name, term), ilike(vendors.email, term))!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'code'
        ? vendors.code
        : query.sortBy === 'createdAt'
          ? vendors.createdAt
          : vendors.name;
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(vendors)
        .where(where)
        .orderBy(query.sortDir === 'desc' ? desc(sortColumn) : asc(sortColumn))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, vendors, where),
    ]);
    const balances = await this.balances(
      companyId,
      rows.map((r) => r.id),
    );
    return toPaginatedResult(
      rows.map((r) => ({ ...r, balance: balances.get(r.id)! })),
      total,
      query,
    );
  }

  async getOrThrow(companyId: string, id: string, executor: DbExecutor = this.db): Promise<Vendor> {
    const [row] = await executor
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, id), eq(vendors.companyId, companyId)));
    if (!row) throw new NotFoundError('Vendor', id);
    return row;
  }

  async getView(companyId: string, id: string): Promise<VendorView> {
    const vendor = await this.getOrThrow(companyId, id);
    const balances = await this.balances(companyId, [id]);
    return { ...vendor, balance: balances.get(id)! };
  }

  async create(companyId: string, input: CreateVendorInput): Promise<VendorView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.defaultExpenseAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultExpenseAccountId, tx);
      let created: Vendor | undefined;
      try {
        [created] = await tx
          .insert(vendors)
          .values({
            companyId,
            ...nullify(input),
            currency: input.currency ?? (await this.accounts.companyCurrency(companyId, tx)),
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'vendors_company_code_uq'))
          throw new DuplicateError('Vendor', 'code', input.code);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Vendor',
          entityId: created.id,
          newValue: created,
          companyId,
        },
        tx,
      );
      return created.id;
    });
    return this.getView(companyId, id);
  }

  async update(companyId: string, id: string, input: UpdateVendorInput): Promise<VendorView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(companyId, id, tx);
      if (input.defaultExpenseAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultExpenseAccountId, tx);
      let updated: Vendor | undefined;
      try {
        [updated] = await tx
          .update(vendors)
          .set(definedOnly(input))
          .where(eq(vendors.id, id))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'vendors_company_code_uq'))
          throw new DuplicateError('Vendor', 'code', input.code ?? '');
        throw err;
      }
      if (!updated) throw new Error('Update returned no row');
      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action:
            input.status && input.status !== existing.status
              ? input.status === 'ACTIVE'
                ? 'ACTIVATE'
                : 'DEACTIVATE'
              : 'UPDATE',
          module: MODULE,
          entityType: 'Vendor',
          entityId: id,
          previousValue: previous,
          newValue: next,
          companyId,
        },
        tx,
      );
    });
    return this.getView(companyId, id);
  }

  /** Open balances per vendor from the subledger documents. */
  async balances(
    companyId: string,
    vendorIds: string[],
    executor: DbExecutor = this.db,
  ): Promise<Map<string, VendorBalance>> {
    const result = new Map<string, VendorBalance>();
    if (vendorIds.length === 0) return result;
    const currency = await this.accounts.companyCurrency(companyId, executor);
    const today = new Date().toISOString().slice(0, 10);
    for (const id of vendorIds)
      result.set(id, {
        outstanding: '0.0000',
        overdue: '0.0000',
        unappliedCredit: '0.0000',
        net: '0.0000',
      });

    const openDocs = await executor
      .select({
        vendorId: vendorBills.vendorId,
        documentType: vendorBills.documentType,
        outstanding: sql<string>`coalesce(sum(${vendorBills.total} - ${vendorBills.allocatedAmount}), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${vendorBills.dueDate} < ${today} then ${vendorBills.total} - ${vendorBills.allocatedAmount} else 0 end), 0)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          inArray(vendorBills.vendorId, vendorIds),
          eq(vendorBills.accountingStatus, 'POSTED'),
          inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
        ),
      )
      .groupBy(vendorBills.vendorId, vendorBills.documentType);

    const payments = await executor
      .select({
        vendorId: vendorPayments.vendorId,
        paymentType: vendorPayments.paymentType,
        unallocated: sql<string>`coalesce(sum(${vendorPayments.amount} - ${vendorPayments.allocatedAmount}), 0)`,
      })
      .from(vendorPayments)
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          inArray(vendorPayments.vendorId, vendorIds),
          eq(vendorPayments.status, 'POSTED'),
        ),
      )
      .groupBy(vendorPayments.vendorId, vendorPayments.paymentType);

    const acc = new Map<string, { outstanding: Money; overdue: Money; credit: Money }>();
    const get = (id: string) =>
      acc.get(id) ?? {
        outstanding: Money.zero(currency),
        overdue: Money.zero(currency),
        credit: Money.zero(currency),
      };
    for (const row of openDocs) {
      const a = get(row.vendorId);
      if (row.documentType === 'CREDIT_NOTE')
        a.credit = a.credit.add(Money.of(row.outstanding, currency));
      else {
        a.outstanding = a.outstanding.add(Money.of(row.outstanding, currency));
        a.overdue = a.overdue.add(Money.of(row.overdue, currency));
      }
      acc.set(row.vendorId, a);
    }
    for (const row of payments) {
      const a = get(row.vendorId);
      const amount = Money.of(row.unallocated, currency);
      a.credit = row.paymentType === 'PAYMENT' ? a.credit.add(amount) : a.credit.subtract(amount);
      acc.set(row.vendorId, a);
    }
    for (const [id, a] of acc) {
      result.set(id, {
        outstanding: a.outstanding.toString(),
        overdue: a.overdue.toString(),
        unappliedCredit: a.credit.toString(),
        net: a.outstanding.subtract(a.credit).toString(),
      });
    }
    return result;
  }
}

function nullify<T extends Record<string, unknown>>(
  input: T,
): { [K in keyof T]: T[K] extends undefined ? null : T[K] } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = v === undefined ? null : v;
  return out as { [K in keyof T]: T[K] extends undefined ? null : T[K] };
}

function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
