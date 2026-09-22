import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import {
  OPEN_DOCUMENT_STATUSES,
  OPEN_ORDER_STATUSES,
  type CreditRuleScope,
} from '@accounting/types';
import type { CreditHoldInput, CreditProfileInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  customerCreditProfiles,
  customers,
  invoices,
  orders,
  type Customer,
  type CustomerCreditProfile,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { daysBetween } from '@/modules/subledger/subledger.logic';
import { businessToday } from '@/common/time/clock';
import { ArConfigService } from './ar-config.service';
import { CustomersService } from './customers.service';
import {
  evaluateCreditRules,
  summarizeCredit,
  type CreditCheckResult,
  type CreditPosition,
  type CreditSummary,
} from './receivables.logic';

const MODULE = 'RECEIVABLES';

/**
 * Credit management: the customer's credit position is always derived from
 * the subledger (posted balances) plus the pipeline (unposted documents and
 * open orders); the configurable credit rules decide whether a sales order
 * or invoice may proceed, needs approval or is blocked. Credit holds are a
 * recorded, audited state on the credit profile - never a customer status.
 */
@Injectable()
export class CreditService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly customersService: CustomersService,
    private readonly config: ArConfigService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  async profile(
    customerId: string,
    executor: DbExecutor = this.db,
  ): Promise<CustomerCreditProfile> {
    const [row] = await executor
      .select()
      .from(customerCreditProfiles)
      .where(eq(customerCreditProfiles.customerId, customerId));
    if (row) return row;
    const [created] = await executor
      .insert(customerCreditProfiles)
      .values({ customerId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(customerCreditProfiles)
      .where(eq(customerCreditProfiles.customerId, customerId));
    return again!;
  }

  /** Everything the credit rules look at, computed from live data. */
  async position(
    companyId: string,
    customer: Customer,
    executor: DbExecutor = this.db,
    options: { excludeDocumentId?: string; excludeOrderId?: string } = {},
  ): Promise<CreditPosition> {
    const currency = customer.currency;
    const balances = await this.customersService.balances(companyId, [customer.id], executor);
    const balance = balances.get(customer.id)!;
    const [pending] = await executor
      .select({ total: sql<string>`coalesce(sum(${invoices.total}), 0)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.customerId, customer.id),
          eq(invoices.accountingStatus, 'UNPOSTED'),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.status} <> 'VOID'`,
          options.excludeDocumentId
            ? sql`${invoices.id} <> ${options.excludeDocumentId}`
            : sql`true`,
        ),
      );
    // Open sales orders: approved / confirmed value not yet invoiced.
    const [openOrders] = await executor
      .select({
        total: sql<string>`coalesce(sum(case when ${orders.billingStatus} = 'FULL' then 0 else ${orders.total} end), 0)`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.companyId, companyId),
          eq(orders.customerId, customer.id),
          eq(orders.orderType, 'SALES_ORDER'),
          inArray(orders.status, [...OPEN_ORDER_STATUSES]),
          options.excludeOrderId ? sql`${orders.id} <> ${options.excludeOrderId}` : sql`true`,
        ),
      );
    const today = businessToday();
    const [oldest] = await executor
      .select({ dueDate: sql<string | null>`min(${invoices.dueDate})` })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.customerId, customer.id),
          eq(invoices.accountingStatus, 'POSTED'),
          inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.dueDate} < ${today}`,
        ),
      );
    const profile = await this.profile(customer.id, executor);
    return {
      creditLimit: customer.creditLimit,
      netBalance: balance.net,
      pendingDocuments: Money.of(pending?.total ?? '0', currency).toString(),
      openOrders: Money.of(openOrders?.total ?? '0', currency).toString(),
      overdue: balance.overdue,
      oldestOverdueDays: oldest?.dueDate ? daysBetween(oldest.dueDate, today) : 0,
      creditHold: profile.creditHold,
    };
  }

  async summary(
    companyId: string,
    customerId: string,
  ): Promise<CreditSummary & { profile: CustomerCreditProfile }> {
    const customer = await this.customersService.getOrThrow(companyId, customerId);
    const position = await this.position(companyId, customer);
    return {
      ...summarizeCredit(position, customer.currency),
      profile: await this.profile(customerId),
    };
  }

  /**
   * Runs the credit rules for a scope. BLOCK raises CREDIT_CHECK_FAILED (or
   * CREDIT_HOLD); REQUIRE_APPROVAL and WARN are returned for the caller to
   * record on the document / route to approval. A customer on hold is always
   * blocked for new orders and invoices regardless of rules - a hold is an
   * explicit decision by someone with credit authority.
   */
  async check(
    tx: DbExecutor,
    companyId: string,
    customer: Customer,
    scope: CreditRuleScope,
    documentAmount: string,
    options: { excludeDocumentId?: string; excludeOrderId?: string } = {},
  ): Promise<CreditCheckResult> {
    const settings = await this.config.settings(companyId, tx);
    const enabled =
      scope === 'SALES_ORDER' ? settings.creditCheckOnSalesOrder : settings.creditCheckOnInvoice;
    const position = await this.position(companyId, customer, tx, options);
    if (position.creditHold) {
      throw new BusinessRuleError(
        ErrorCodes.CREDIT_HOLD,
        `Customer ${customer.code} is on credit hold; release the hold before continuing.`,
        { customerId: customer.id },
      );
    }
    if (!enabled) {
      return { outcome: null, findings: [], summary: summarizeCredit(position, customer.currency) };
    }
    const rules = await this.config.activeCreditRules(companyId, tx);
    const result = evaluateCreditRules(
      rules,
      scope,
      position,
      documentAmount,
      customer.customerGroupId,
      customer.currency,
    );
    if (result.outcome === 'BLOCK') {
      throw new BusinessRuleError(
        ErrorCodes.CREDIT_CHECK_FAILED,
        `Credit check failed for ${customer.code}: ${result.findings.map((f) => f.message).join(' ')}`,
        { findings: result.findings, summary: result.summary },
      );
    }
    return result;
  }

  /** Credit limit / risk / review changes - audited as CREDIT_LIMIT_CHANGED etc. */
  async updateProfile(
    companyId: string,
    actor: AuthenticatedUser,
    customerId: string,
    input: CreditProfileInput,
  ): Promise<CreditSummary & { profile: CustomerCreditProfile }> {
    await this.db.transaction(async (tx) => {
      const customer = await this.customersService.getOrThrow(companyId, customerId, tx);
      const profile = await this.profile(customerId, tx);
      if (input.creditLimit !== undefined && input.creditLimit !== customer.creditLimit) {
        await tx
          .update(customers)
          .set({ creditLimit: input.creditLimit })
          .where(eq(customers.id, customerId));
        await this.audit.record(
          {
            action: 'UPDATE',
            module: MODULE,
            entityType: 'Customer',
            entityId: customerId,
            previousValue: { creditLimit: customer.creditLimit },
            newValue: { creditLimit: input.creditLimit },
            metadata: { kind: 'CREDIT_LIMIT_CHANGED', code: customer.code, editor: actor.email },
            companyId,
          },
          tx,
        );
      }
      const patch: Partial<typeof customerCreditProfiles.$inferInsert> = {};
      if (input.riskRating !== undefined) patch.riskRating = input.riskRating;
      if (input.reviewDate !== undefined) patch.reviewDate = input.reviewDate;
      if (input.notes !== undefined) patch.notes = input.notes ?? null;
      if (Object.keys(patch).length) {
        patch.reviewedBy = actor.id;
        patch.reviewedAt = new Date();
        await tx
          .update(customerCreditProfiles)
          .set(patch)
          .where(eq(customerCreditProfiles.customerId, customerId));
        await this.audit.record(
          {
            action: 'UPDATE',
            module: MODULE,
            entityType: 'CustomerCreditProfile',
            entityId: customerId,
            previousValue: { riskRating: profile.riskRating, reviewDate: profile.reviewDate },
            newValue: patch,
            metadata: { code: customer.code, editor: actor.email },
            companyId,
          },
          tx,
        );
      }
      if (input.creditHold !== undefined && input.creditHold !== profile.creditHold) {
        await this.setHold(tx, companyId, actor, customer, {
          hold: input.creditHold,
          reason:
            input.creditHoldReason ??
            (input.creditHold ? 'Credit review' : 'Released after review'),
        });
      }
    });
    return this.summary(companyId, customerId);
  }

  async hold(
    companyId: string,
    actor: AuthenticatedUser,
    customerId: string,
    input: CreditHoldInput,
  ): Promise<CreditSummary & { profile: CustomerCreditProfile }> {
    await this.db.transaction(async (tx) => {
      const customer = await this.customersService.getOrThrow(companyId, customerId, tx);
      await this.setHold(tx, companyId, actor, customer, input);
    });
    return this.summary(companyId, customerId);
  }

  /** Applies / releases a hold inside the caller's transaction (also used by dunning). */
  async setHold(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser | { id: string | null; email: string; organizationId: string },
    customer: Customer,
    input: CreditHoldInput,
    source: 'MANUAL' | 'DUNNING' = 'MANUAL',
  ): Promise<void> {
    const profile = await this.profile(customer.id, tx);
    if (profile.creditHold === input.hold) return;
    await tx
      .update(customerCreditProfiles)
      .set({
        creditHold: input.hold,
        creditHoldReason: input.reason,
        creditHoldAt: new Date(),
        creditHoldBy: actor.id,
        creditHoldSource: input.hold ? source : null,
      })
      .where(eq(customerCreditProfiles.customerId, customer.id));
    await this.audit.record(
      {
        action: 'UPDATE',
        module: MODULE,
        entityType: 'CustomerCreditProfile',
        entityId: customer.id,
        previousValue: { creditHold: profile.creditHold },
        newValue: { creditHold: input.hold, reason: input.reason, source },
        metadata: { kind: 'CREDIT_HOLD_CHANGED', code: customer.code, editor: actor.email },
        companyId,
        userId: actor.id,
        userEmail: actor.email,
      },
      tx,
    );
    await this.outbox.enqueue(tx, {
      eventType: input.hold ? 'customer.credit_hold' : 'customer.credit_released',
      companyId,
      payload: {
        customerId: customer.id,
        code: customer.code,
        name: customer.name,
        reason: input.reason,
        source,
      },
    });
    if (input.hold) {
      await this.notifications.notify(
        {
          organizationId: actor.organizationId,
          eventType: 'CUSTOMER_CREDIT_HOLD',
          severity: 'WARNING',
          title: `${customer.name} placed on credit hold`,
          body: input.reason,
          link: `/receivables/customers/${customer.id}`,
          entityType: 'Customer',
          entityId: customer.id,
          permission: 'customer.credit-manage',
          companyId,
          dedupeKey: `credit-hold:${customer.id}`,
        },
        tx,
      );
    }
  }

  /** Warns credit managers when a customer's exposure crosses the limit (throttled per customer). */
  async notifyOverLimit(
    tx: DbExecutor,
    companyId: string,
    customer: Customer,
    summary: CreditSummary,
  ): Promise<void> {
    if (summary.status !== 'OVER_LIMIT') return;
    const [company] = await tx
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) return;
    await this.outbox.enqueue(tx, {
      eventType: 'customer.over_credit_limit',
      companyId,
      dedupeKey: `customer.over_credit_limit:${customer.id}:${businessToday()}`,
      payload: { customerId: customer.id, code: customer.code, ...summary },
    });
    await this.notifications.notify(
      {
        organizationId: company.organizationId,
        eventType: 'CUSTOMER_OVER_CREDIT_LIMIT',
        severity: 'WARNING',
        title: `${customer.name} is over its credit limit`,
        body: `Credit used ${summary.creditUsed} against a limit of ${summary.creditLimit}.`,
        link: `/receivables/customers/${customer.id}`,
        entityType: 'Customer',
        entityId: customer.id,
        permission: 'customer.credit-manage',
        companyId,
        dedupeKey: `over-limit:${customer.id}`,
      },
      tx,
    );
  }
}
