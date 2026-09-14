import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { OPEN_DOCUMENT_STATUSES, type PaginatedResult } from '@accounting/types';
import type {
  CreateCustomerInput,
  ListPartiesQuery,
  UpdateCustomerInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { customerPayments, customers, invoices, type Customer } from '@/database/schema';

const MODULE = 'RECEIVABLES';

export interface CustomerBalance {
  /** Open invoices/debit notes not yet settled. */
  outstanding: string;
  /** Portion of `outstanding` past its due date (as of today). */
  overdue: string;
  /** Unapplied credit notes plus unallocated receipts (net of refunds). */
  unappliedCredit: string;
  /** outstanding - unappliedCredit */
  net: string;
}

export interface CustomerView extends Customer {
  balance: CustomerBalance;
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly outbox: OutboxService,
  ) {}

  async list(companyId: string, query: ListPartiesQuery): Promise<PaginatedResult<CustomerView>> {
    const filters: SQL[] = [eq(customers.companyId, companyId)];
    if (query.status) filters.push(eq(customers.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(ilike(customers.code, term), ilike(customers.name, term), ilike(customers.email, term))!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'code'
        ? customers.code
        : query.sortBy === 'createdAt'
          ? customers.createdAt
          : customers.name;
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(customers)
        .where(where)
        .orderBy(query.sortDir === 'desc' ? desc(sortColumn) : asc(sortColumn))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, customers, where),
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

  async getOrThrow(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Customer> {
    const [row] = await executor
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.companyId, companyId)));
    if (!row) throw new NotFoundError('Customer', id);
    return row;
  }

  async getView(companyId: string, id: string): Promise<CustomerView> {
    const customer = await this.getOrThrow(companyId, id);
    const balances = await this.balances(companyId, [id]);
    return { ...customer, balance: balances.get(id)! };
  }

  async create(companyId: string, input: CreateCustomerInput): Promise<CustomerView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.defaultRevenueAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultRevenueAccountId, tx);
      let created: Customer | undefined;
      try {
        [created] = await tx
          .insert(customers)
          .values({
            companyId,
            ...nullify(input),
            currency: input.currency ?? (await this.accounts.companyCurrency(companyId, tx)),
            creditLimit: input.creditLimit ?? null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'customers_company_code_uq'))
          throw new DuplicateError('Customer', 'code', input.code);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Customer',
          entityId: created.id,
          newValue: created,
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'customer.created',
        companyId,
        dedupeKey: 'customer.created:' + created.id,
        payload: {
          customerId: created.id,
          code: created.code,
          name: created.name,
          currency: created.currency,
          status: created.status,
        },
      });
      return created.id;
    });
    return this.getView(companyId, id);
  }

  async update(companyId: string, id: string, input: UpdateCustomerInput): Promise<CustomerView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(companyId, id, tx);
      if (input.defaultRevenueAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultRevenueAccountId, tx);
      let updated: Customer | undefined;
      try {
        [updated] = await tx
          .update(customers)
          .set(definedOnly(input))
          .where(eq(customers.id, id))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'customers_company_code_uq'))
          throw new DuplicateError('Customer', 'code', input.code ?? '');
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
          entityType: 'Customer',
          entityId: id,
          previousValue: previous,
          newValue: next,
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'customer.updated',
        companyId,
        payload: {
          customerId: id,
          code: updated.code,
          name: updated.name,
          status: updated.status,
          changed: Object.keys(next ?? {}),
        },
      });
    });
    return this.getView(companyId, id);
  }

  /** Open balances per customer from the subledger documents. */
  async balances(
    companyId: string,
    customerIds: string[],
    executor: DbExecutor = this.db,
  ): Promise<Map<string, CustomerBalance>> {
    const result = new Map<string, CustomerBalance>();
    if (customerIds.length === 0) return result;
    const currency = await this.accounts.companyCurrency(companyId, executor);
    const today = new Date().toISOString().slice(0, 10);
    for (const id of customerIds)
      result.set(id, {
        outstanding: '0.0000',
        overdue: '0.0000',
        unappliedCredit: '0.0000',
        net: '0.0000',
      });

    const openDocs = await executor
      .select({
        customerId: invoices.customerId,
        documentType: invoices.documentType,
        outstanding: sql<string>`coalesce(sum(${invoices.total} - ${invoices.allocatedAmount}), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${invoices.dueDate} < ${today} then ${invoices.total} - ${invoices.allocatedAmount} else 0 end), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          inArray(invoices.customerId, customerIds),
          eq(invoices.accountingStatus, 'POSTED'),
          inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
        ),
      )
      .groupBy(invoices.customerId, invoices.documentType);

    const payments = await executor
      .select({
        customerId: customerPayments.customerId,
        paymentType: customerPayments.paymentType,
        unallocated: sql<string>`coalesce(sum(${customerPayments.amount} - ${customerPayments.allocatedAmount}), 0)`,
      })
      .from(customerPayments)
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          inArray(customerPayments.customerId, customerIds),
          eq(customerPayments.status, 'POSTED'),
        ),
      )
      .groupBy(customerPayments.customerId, customerPayments.paymentType);

    const acc = new Map<string, { outstanding: Money; overdue: Money; credit: Money }>();
    const get = (id: string) =>
      acc.get(id) ?? {
        outstanding: Money.zero(currency),
        overdue: Money.zero(currency),
        credit: Money.zero(currency),
      };
    for (const row of openDocs) {
      const a = get(row.customerId);
      if (row.documentType === 'CREDIT_NOTE')
        a.credit = a.credit.add(Money.of(row.outstanding, currency));
      else {
        a.outstanding = a.outstanding.add(Money.of(row.outstanding, currency));
        a.overdue = a.overdue.add(Money.of(row.overdue, currency));
      }
      acc.set(row.customerId, a);
    }
    for (const row of payments) {
      const a = get(row.customerId);
      const amount = Money.of(row.unallocated, currency);
      a.credit = row.paymentType === 'PAYMENT' ? a.credit.add(amount) : a.credit.subtract(amount);
      acc.set(row.customerId, a);
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
