import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { OPEN_DOCUMENT_STATUSES, type PaginatedResult } from '@accounting/types';
import type {
  CreateCustomerInput,
  CustomerAddressInput,
  CustomerContactInput,
  ListPartiesQuery,
  UpdateCustomerInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  customerAddresses,
  customerContacts,
  customerCreditProfiles,
  customerGroups,
  customerPayments,
  customers,
  invoices,
  paymentTerms,
  users,
  type Customer,
  type CustomerAddress,
  type CustomerContact,
  type CustomerCreditProfile,
} from '@/database/schema';
import { ArConfigService } from './ar-config.service';

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
  customerGroupName: string | null;
  paymentTermName: string | null;
  salespersonName: string | null;
  creditHold: boolean;
  riskRating: CustomerCreditProfile['riskRating'];
}

export interface CustomerDetail extends CustomerView {
  contacts: CustomerContact[];
  addresses: CustomerAddress[];
  creditProfile: CustomerCreditProfile | null;
}

/**
 * Customer master. Balances are never stored: they are derived from posted
 * subledger documents and receipts every time (one source of truth).
 */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly outbox: OutboxService,
    private readonly config: ArConfigService,
  ) {}

  async list(companyId: string, query: ListPartiesQuery): Promise<PaginatedResult<CustomerView>> {
    const filters: SQL[] = [eq(customers.companyId, companyId)];
    if (query.status) filters.push(eq(customers.status, query.status));
    if (query.customerGroupId) filters.push(eq(customers.customerGroupId, query.customerGroupId));
    if (query.customerType) filters.push(eq(customers.customerType, query.customerType));
    if (query.salespersonId) filters.push(eq(customers.salespersonId, query.salespersonId));
    if (query.creditHold) filters.push(eq(customerCreditProfiles.creditHold, true));
    if (query.overdueOnly) {
      const today = new Date().toISOString().slice(0, 10);
      filters.push(
        sql`exists (select 1 from invoices i where i.customer_id = ${customers.id} and i.accounting_status = 'POSTED' and i.status in ('APPROVED', 'PARTIALLY_PAID') and i.document_type in ('INVOICE', 'DEBIT_NOTE') and i.due_date < ${today})`,
      );
    }
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(customers.code, term),
          ilike(customers.name, term),
          ilike(customers.email, term),
          ilike(customers.displayName, term),
        )!,
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
      this.viewQuery(this.db)
        .where(where)
        .orderBy(query.sortDir === 'desc' ? desc(sortColumn) : asc(sortColumn))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(customers)
        .leftJoin(customerCreditProfiles, eq(customerCreditProfiles.customerId, customers.id))
        .where(where)
        .then((r) => Number(r[0]?.n ?? 0)),
    ]);
    const balances = await this.balances(
      companyId,
      rows.map((r) => r.customer.id),
    );
    return toPaginatedResult(
      rows.map((r) => this.decorate(r, balances.get(r.customer.id)!)),
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

  async getView(companyId: string, id: string): Promise<CustomerDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(customers.id, id), eq(customers.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Customer', id);
    const [balances, contacts, addresses, profile] = await Promise.all([
      this.balances(companyId, [id]),
      this.db
        .select()
        .from(customerContacts)
        .where(eq(customerContacts.customerId, id))
        .orderBy(desc(customerContacts.isPrimary), asc(customerContacts.name)),
      this.db
        .select()
        .from(customerAddresses)
        .where(eq(customerAddresses.customerId, id))
        .orderBy(asc(customerAddresses.addressType), desc(customerAddresses.isDefault)),
      this.db
        .select()
        .from(customerCreditProfiles)
        .where(eq(customerCreditProfiles.customerId, id)),
    ]);
    return {
      ...this.decorate(row, balances.get(id)!),
      contacts,
      addresses,
      creditProfile: profile[0] ?? null,
    };
  }

  async create(
    companyId: string,
    input: CreateCustomerInput,
    actor?: { id: string; email: string },
  ): Promise<CustomerDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.defaultRevenueAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultRevenueAccountId, tx);
      const group = input.customerGroupId
        ? await this.config.customerGroup(companyId, input.customerGroupId, tx)
        : null;
      const settings = await this.config.settings(companyId, tx);
      // Group and company defaults fill what the caller left out; explicit net days win over a default term.
      const paymentTermId =
        input.paymentTermId ??
        (input.paymentTermsDays === undefined
          ? (group?.paymentTermId ?? settings.defaultPaymentTermId ?? null)
          : null);
      const term = paymentTermId
        ? await this.config.paymentTerm(companyId, paymentTermId, tx)
        : null;
      const paymentTermsDays =
        input.paymentTermsDays ?? (term && term.basis === 'NET_DAYS' ? term.days : 30);
      if (input.salespersonId) await this.assertUser(tx, input.salespersonId);
      const creditLimit =
        input.creditLimit !== undefined ? input.creditLimit : (group?.defaultCreditLimit ?? null);
      let created: Customer | undefined;
      try {
        [created] = await tx
          .insert(customers)
          .values({
            companyId,
            ...nullify(input),
            currency: input.currency ?? (await this.accounts.companyCurrency(companyId, tx)),
            creditLimit,
            paymentTermId,
            paymentTermsDays,
            customerGroupId: group?.id ?? null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'customers_company_code_uq'))
          throw new DuplicateError('Customer', 'code', input.code);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');
      await tx
        .insert(customerCreditProfiles)
        .values({ customerId: created.id })
        .onConflictDoNothing();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Customer',
          entityId: created.id,
          newValue: created,
          metadata: actor ? { editor: actor.email } : undefined,
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
          customerType: created.customerType,
          currency: created.currency,
          status: created.status,
        },
      });
      return created.id;
    });
    return this.getView(companyId, id);
  }

  async update(
    companyId: string,
    id: string,
    input: UpdateCustomerInput,
    actor?: { id: string; email: string },
  ): Promise<CustomerDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(companyId, id, tx);
      if (input.defaultRevenueAccountId)
        await this.accounts.getOrThrow(companyId, input.defaultRevenueAccountId, tx);
      if (input.customerGroupId)
        await this.config.customerGroup(companyId, input.customerGroupId, tx);
      if (input.paymentTermId) await this.config.paymentTerm(companyId, input.paymentTermId, tx);
      if (input.salespersonId) await this.assertUser(tx, input.salespersonId);
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
      const creditLimitChanged =
        input.creditLimit !== undefined && input.creditLimit !== existing.creditLimit;
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
          metadata: {
            ...(creditLimitChanged ? { kind: 'CREDIT_LIMIT_CHANGED' } : {}),
            ...(actor ? { editor: actor.email } : {}),
          },
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

  // ---------------------------------------------------------------- contacts

  async addContact(
    companyId: string,
    id: string,
    input: CustomerContactInput,
  ): Promise<CustomerContact> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      if (input.isPrimary)
        await tx
          .update(customerContacts)
          .set({ isPrimary: false })
          .where(eq(customerContacts.customerId, id));
      const [row] = await tx
        .insert(customerContacts)
        .values({ customerId: id, ...nullify(input) })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'CustomerContact',
          entityId: row!.id,
          newValue: row,
          metadata: { customerId: id },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateContact(
    companyId: string,
    id: string,
    contactId: string,
    input: Partial<CustomerContactInput>,
  ): Promise<CustomerContact> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      if (input.isPrimary)
        await tx
          .update(customerContacts)
          .set({ isPrimary: false })
          .where(eq(customerContacts.customerId, id));
      const [row] = await tx
        .update(customerContacts)
        .set(definedOnly(input))
        .where(and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, id)))
        .returning();
      if (!row) throw new NotFoundError('Contact', contactId);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CustomerContact',
          entityId: contactId,
          newValue: input,
          metadata: { customerId: id },
          companyId,
        },
        tx,
      );
      return row;
    });
  }

  async removeContact(companyId: string, id: string, contactId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      const deleted = await tx
        .delete(customerContacts)
        .where(and(eq(customerContacts.id, contactId), eq(customerContacts.customerId, id)))
        .returning({ id: customerContacts.id });
      if (!deleted.length) throw new NotFoundError('Contact', contactId);
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'CustomerContact',
          entityId: contactId,
          metadata: { customerId: id },
          companyId,
        },
        tx,
      );
    });
  }

  // --------------------------------------------------------------- addresses

  async addAddress(
    companyId: string,
    id: string,
    input: CustomerAddressInput,
  ): Promise<CustomerAddress> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      if (input.isDefault)
        await tx
          .update(customerAddresses)
          .set({ isDefault: false })
          .where(
            and(
              eq(customerAddresses.customerId, id),
              eq(customerAddresses.addressType, input.addressType),
            ),
          );
      const [row] = await tx
        .insert(customerAddresses)
        .values({ customerId: id, ...nullify(input) })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'CustomerAddress',
          entityId: row!.id,
          newValue: row,
          metadata: { customerId: id },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateAddress(
    companyId: string,
    id: string,
    addressId: string,
    input: Partial<CustomerAddressInput>,
  ): Promise<CustomerAddress> {
    return this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      const [current] = await tx
        .select()
        .from(customerAddresses)
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, id)));
      if (!current) throw new NotFoundError('Address', addressId);
      if (input.isDefault)
        await tx
          .update(customerAddresses)
          .set({ isDefault: false })
          .where(
            and(
              eq(customerAddresses.customerId, id),
              eq(customerAddresses.addressType, input.addressType ?? current.addressType),
            ),
          );
      const [row] = await tx
        .update(customerAddresses)
        .set(definedOnly(input))
        .where(eq(customerAddresses.id, addressId))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CustomerAddress',
          entityId: addressId,
          newValue: input,
          metadata: { customerId: id },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async removeAddress(companyId: string, id: string, addressId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.getOrThrow(companyId, id, tx);
      const deleted = await tx
        .delete(customerAddresses)
        .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, id)))
        .returning({ id: customerAddresses.id });
      if (!deleted.length) throw new NotFoundError('Address', addressId);
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'CustomerAddress',
          entityId: addressId,
          metadata: { customerId: id },
          companyId,
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------- balances

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

  // --------------------------------------------------------------- internals

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        customer: customers,
        customerGroupName: customerGroups.name,
        paymentTermName: paymentTerms.name,
        salespersonName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
        creditHold: sql<boolean>`coalesce(${customerCreditProfiles.creditHold}, false)`,
        riskRating: sql<
          CustomerCreditProfile['riskRating']
        >`coalesce(${customerCreditProfiles.riskRating}, 'LOW')`,
      })
      .from(customers)
      .leftJoin(customerGroups, eq(customerGroups.id, customers.customerGroupId))
      .leftJoin(paymentTerms, eq(paymentTerms.id, customers.paymentTermId))
      .leftJoin(users, eq(users.id, customers.salespersonId))
      .leftJoin(customerCreditProfiles, eq(customerCreditProfiles.customerId, customers.id));
  }

  private decorate(
    row: {
      customer: Customer;
      customerGroupName: string | null;
      paymentTermName: string | null;
      salespersonName: string | null;
      creditHold: boolean;
      riskRating: CustomerCreditProfile['riskRating'];
    },
    balance: CustomerBalance,
  ): CustomerView {
    return {
      ...row.customer,
      id: row.customer.id,
      balance,
      customerGroupName: row.customerGroupName,
      paymentTermName: row.paymentTermName,
      salespersonName: row.salespersonName,
      creditHold: row.creditHold,
      riskRating: row.riskRating,
    };
  }

  private async assertUser(tx: DbExecutor, userId: string): Promise<void> {
    const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!row) throw new NotFoundError('User', userId);
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
