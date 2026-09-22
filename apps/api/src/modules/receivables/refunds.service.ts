import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CreateRefundRequestInput,
  ListRefundsQuery,
  PayRefundInput,
  RefundDecisionInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  customerPayments,
  customers,
  invoices,
  paymentRefunds,
  type PaymentRefund,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { businessToday } from '@/common/time/clock';
import { CustomerPaymentsService } from './customer-payments.service';
import { CustomersService } from './customers.service';

const MODULE = 'RECEIVABLES';

export interface RefundView extends PaymentRefund {
  customerCode: string;
  customerName: string;
  paymentNumber: string | null;
  creditNoteNumber: string | null;
  refundPaymentNumber: string | null;
  requestedByName: string | null;
}

/**
 * Customer refunds (Prompt #6): customer credit -> refund request -> approval
 * -> payment. The request is the control: it is capped by the customer's
 * unapplied credit, approval is workflow + delegated-authority gated with a
 * hard requester/approver separation, and paying it creates and posts a
 * REFUND receipt through CustomerPaymentsService (Dr AR / Cr cash via the
 * posting gateway) in the same transaction.
 */
@Injectable()
export class RefundsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly numbering: DocumentNumberingService,
    private readonly customersService: CustomersService,
    private readonly payments: CustomerPaymentsService,
    private readonly approvals: ApprovalsService,
    private readonly authority: AuthorityService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(companyId: string, query: ListRefundsQuery): Promise<PaginatedResult<RefundView>> {
    const filters: SQL[] = [eq(paymentRefunds.companyId, companyId)];
    if (query.customerId) filters.push(eq(paymentRefunds.customerId, query.customerId));
    if (query.status) filters.push(eq(paymentRefunds.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(paymentRefunds.documentNumber, term),
          ilike(customers.name, term),
          ilike(paymentRefunds.reason, term),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, count] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc' ? asc(paymentRefunds.createdAt) : desc(paymentRefunds.createdAt),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(paymentRefunds)
        .innerJoin(customers, eq(customers.id, paymentRefunds.customerId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(count[0]?.n ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<RefundView> {
    const [row] = await this.viewQuery().where(
      and(eq(paymentRefunds.id, id), eq(paymentRefunds.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Refund request', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateRefundRequestInput,
  ): Promise<RefundView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: paymentRefunds.id })
          .from(paymentRefunds)
          .where(
            and(
              eq(paymentRefunds.companyId, companyId),
              eq(paymentRefunds.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const customer = await this.customersService.getOrThrow(companyId, input.customerId, tx);
      const amount = Money.parse(input.amount, customer.currency);
      await this.assertWithinCredit(tx, companyId, customer.id, amount, customer.currency);
      const cash = await this.accounts.getOrThrow(companyId, input.cashAccountId, tx);
      if (cash.isHeader || cash.status !== 'ACTIVE' || cash.type !== 'ASSET')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${cash.code} is not a usable cash or bank account.`,
        );
      if (input.paymentId) {
        const [p] = await tx
          .select({ id: customerPayments.id, customerId: customerPayments.customerId })
          .from(customerPayments)
          .where(
            and(
              eq(customerPayments.id, input.paymentId),
              eq(customerPayments.companyId, companyId),
            ),
          );
        if (!p || p.customerId !== customer.id)
          throw new NotFoundError('Customer payment', input.paymentId);
      }
      if (input.creditNoteId) {
        const [cn] = await tx
          .select({
            id: invoices.id,
            customerId: invoices.customerId,
            documentType: invoices.documentType,
          })
          .from(invoices)
          .where(and(eq(invoices.id, input.creditNoteId), eq(invoices.companyId, companyId)));
        if (!cn || cn.customerId !== customer.id || cn.documentType !== 'CREDIT_NOTE')
          throw new NotFoundError('Credit note', input.creditNoteId);
      }
      const documentNumber = await this.numbering.allocate(
        companyId,
        'RFD',
        Number(businessToday().slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(paymentRefunds)
        .values({
          companyId,
          branchId: input.branchId ?? null,
          documentNumber,
          customerId: customer.id,
          paymentId: input.paymentId ?? null,
          creditNoteId: input.creditNoteId ?? null,
          currency: customer.currency,
          amount: amount.toString(),
          reason: input.reason,
          method: input.method,
          cashAccountId: input.cashAccountId,
          reference: input.reference ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          requestedBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'RefundRequest',
          entityId: created!.id,
          newValue: { documentNumber, amount: amount.toString(), customerId: customer.id },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async submit(companyId: string, actor: AuthenticatedUser, id: string): Promise<RefundView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'submitted');
      await this.approvals.open(tx, this.workflowRef(companyId, existing, actor.id));
      await tx
        .update(paymentRefunds)
        .set({ status: 'SUBMITTED', submittedAt: new Date() })
        .where(eq(paymentRefunds.id, id));
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'RefundRequest',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'SUBMITTED' },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      await this.notify(tx, companyId, existing, {
        eventType: 'REFUND_APPROVAL_REQUIRED',
        title: `Refund ${existing.documentNumber} awaits approval`,
        body: `${existing.currency} ${existing.amount}: ${existing.reason}`,
        permission: P['customer-refund.approve'],
      });
    });
    return this.get(companyId, id);
  }

  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: RefundDecisionInput,
  ): Promise<RefundView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'SUBMITTED'], 'approved');
      if (existing.requestedBy === actor.id)
        throw new BusinessRuleError(
          ErrorCodes.SOD_VIOLATION,
          'A refund cannot be approved by the person who requested it.',
        );
      await this.approvals.assertApproved(
        tx,
        this.workflowRef(companyId, existing, existing.requestedBy ?? actor.id),
      );
      const customer = await this.customersService.getOrThrow(companyId, existing.customerId, tx);
      await this.assertWithinCredit(
        tx,
        companyId,
        customer.id,
        Money.of(existing.amount, existing.currency),
        existing.currency,
        existing.id,
      );
      const authority = await this.authority.assert(tx, actor, P['customer-refund.approve'], {
        companyId,
        branchId: existing.branchId,
        amount: existing.amount,
        currency: existing.currency,
        documentType: 'CUSTOMER_REFUND',
        documentId: id,
        documentNumber: existing.documentNumber,
        createdBy: existing.requestedBy,
        action: 'Approved customer refund',
      });
      await tx
        .update(paymentRefunds)
        .set({
          status: 'APPROVED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          decisionComment: input.comment ?? null,
        })
        .where(eq(paymentRefunds.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'RefundRequest',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'APPROVED', comment: input.comment },
          metadata: { documentNumber: existing.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'refund.approved',
        companyId,
        dedupeKey: 'refund.approved:' + id,
        payload: {
          refundId: id,
          documentNumber: existing.documentNumber,
          customerId: existing.customerId,
          amount: existing.amount,
          currency: existing.currency,
        },
      });
    });
    return this.get(companyId, id);
  }

  async reject(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: RefundDecisionInput,
  ): Promise<RefundView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'SUBMITTED'], 'rejected');
      await this.approvals.cancelFor(tx, 'CUSTOMER_REFUND', id);
      await tx
        .update(paymentRefunds)
        .set({
          status: 'REJECTED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          decisionComment: input.comment ?? null,
        })
        .where(eq(paymentRefunds.id, id));
      await this.audit.record(
        {
          action: 'REJECT',
          module: MODULE,
          entityType: 'RefundRequest',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'REJECTED', comment: input.comment },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: RefundDecisionInput,
  ): Promise<RefundView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'SUBMITTED', 'APPROVED'], 'cancelled');
      await this.approvals.cancelFor(tx, 'CUSTOMER_REFUND', id);
      await tx
        .update(paymentRefunds)
        .set({ status: 'CANCELLED', decisionComment: input.comment ?? null })
        .where(eq(paymentRefunds.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'RefundRequest',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'CANCELLED' },
          metadata: { documentNumber: existing.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** APPROVED -> PAID: drafts and posts the REFUND receipt in one transaction. */
  async pay(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: PayRefundInput,
  ): Promise<RefundView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['APPROVED'], 'paid');
      const paymentId = await this.payments.createInTx(tx, companyId, actor, {
        partyId: existing.customerId,
        paymentType: 'REFUND',
        paymentDate: input.paymentDate,
        amount: existing.amount,
        method: existing.method,
        cashAccountId: existing.cashAccountId,
        reference: input.reference ?? existing.reference ?? existing.documentNumber,
        memo: `Refund ${existing.documentNumber}: ${existing.reason}`,
        branchId: existing.branchId,
        allocations: [],
        idempotencyKey: `refund:${existing.id}`,
      });
      // The refund request carried the approval; the payment inherits it.
      await tx
        .update(customerPayments)
        .set({ approvedBy: existing.approvedBy, approvedAt: existing.approvedAt })
        .where(eq(customerPayments.id, paymentId));
      await this.payments.postInTx(tx, companyId, actor, paymentId, { approvedUpstream: true });
      await tx
        .update(paymentRefunds)
        .set({ status: 'PAID', refundPaymentId: paymentId, paidBy: actor.id, paidAt: new Date() })
        .where(eq(paymentRefunds.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'RefundRequest',
          entityId: id,
          previousValue: { status: 'APPROVED' },
          newValue: { status: 'PAID', refundPaymentId: paymentId },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  // --------------------------------------------------------------- internals

  /** Refunds (this request plus other open ones) can never exceed the customer's unapplied credit. */
  private async assertWithinCredit(
    tx: DbExecutor,
    companyId: string,
    customerId: string,
    amount: Money,
    currency: string,
    excludeId: string | null = null,
  ): Promise<void> {
    const balances = await this.customersService.balances(companyId, [customerId], tx);
    const credit = Money.of(balances.get(customerId)!.unappliedCredit, currency);
    const [pending] = await tx
      .select({ total: sql<string>`coalesce(sum(${paymentRefunds.amount}), 0)` })
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.customerId, customerId),
          sql`${paymentRefunds.status} in ('SUBMITTED', 'APPROVED')`,
          excludeId ? sql`${paymentRefunds.id} <> ${excludeId}` : sql`true`,
        ),
      );
    const committed = Money.of(pending?.total ?? '0', currency).add(amount);
    if (committed.greaterThan(credit))
      throw new BusinessRuleError(
        ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
        `Refunds of ${committed.toString()} exceed the customer's unapplied credit ${credit.toString()}.`,
        { unappliedCredit: credit.toString(), committed: committed.toString() },
      );
  }

  private workflowRef(companyId: string, doc: PaymentRefund, requestedBy: string) {
    return {
      companyId,
      documentType: 'CUSTOMER_REFUND' as const,
      documentId: doc.id,
      documentNumber: doc.documentNumber,
      amount: doc.amount,
      currency: doc.currency,
      requestedBy,
    };
  }

  private async notify(
    tx: DbExecutor,
    companyId: string,
    doc: PaymentRefund,
    input: {
      eventType: 'REFUND_APPROVAL_REQUIRED';
      title: string;
      body: string;
      permission: string;
    },
  ): Promise<void> {
    const [company] = await tx
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) return;
    await this.notifications.notify(
      {
        organizationId: company.organizationId,
        eventType: input.eventType,
        title: input.title,
        body: input.body,
        link: `/receivables/refunds/${doc.id}`,
        entityType: 'RefundRequest',
        entityId: doc.id,
        permission: input.permission,
        companyId,
        dedupeKey: `${input.eventType}:${doc.id}`,
      },
      tx,
    );
  }

  private viewQuery() {
    return this.db
      .select({
        id: paymentRefunds.id,
        companyId: paymentRefunds.companyId,
        branchId: paymentRefunds.branchId,
        documentNumber: paymentRefunds.documentNumber,
        customerId: paymentRefunds.customerId,
        paymentId: paymentRefunds.paymentId,
        creditNoteId: paymentRefunds.creditNoteId,
        status: paymentRefunds.status,
        currency: paymentRefunds.currency,
        amount: paymentRefunds.amount,
        reason: paymentRefunds.reason,
        method: paymentRefunds.method,
        cashAccountId: paymentRefunds.cashAccountId,
        reference: paymentRefunds.reference,
        refundPaymentId: paymentRefunds.refundPaymentId,
        decisionComment: paymentRefunds.decisionComment,
        idempotencyKey: paymentRefunds.idempotencyKey,
        requestedBy: paymentRefunds.requestedBy,
        submittedAt: paymentRefunds.submittedAt,
        approvedBy: paymentRefunds.approvedBy,
        approvedAt: paymentRefunds.approvedAt,
        paidBy: paymentRefunds.paidBy,
        paidAt: paymentRefunds.paidAt,
        createdAt: paymentRefunds.createdAt,
        updatedAt: paymentRefunds.updatedAt,
        customerCode: customers.code,
        customerName: customers.name,
        paymentNumber: sql<
          string | null
        >`(select document_number from customer_payments p where p.id = ${paymentRefunds.paymentId})`,
        creditNoteNumber: sql<
          string | null
        >`(select document_number from invoices i where i.id = ${paymentRefunds.creditNoteId})`,
        refundPaymentNumber: sql<
          string | null
        >`(select document_number from customer_payments p where p.id = ${paymentRefunds.refundPaymentId})`,
        requestedByName: sql<
          string | null
        >`(select first_name || ' ' || last_name from users u where u.id = ${paymentRefunds.requestedBy})`,
      })
      .from(paymentRefunds)
      .innerJoin(customers, eq(customers.id, paymentRefunds.customerId));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<PaymentRefund> {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.id, id), eq(paymentRefunds.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Refund request', id);
    return row;
  }

  private assertStatus(doc: PaymentRefund, allowed: PaymentRefund['status'][], verb: string): void {
    if (!allowed.includes(doc.status))
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${doc.documentNumber} cannot be ${verb} from status ${doc.status}.`,
        { status: doc.status, allowed },
      );
  }
}
