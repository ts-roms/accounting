import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  AllocateInput,
  CreatePaymentInput,
  ListPaymentsQuery,
  UpdatePaymentInput,
  VoidDocumentInput,
} from '@accounting/validation';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  assertAccountTakesCurrency,
  foreignLineFields,
} from '@/modules/accounting/journals/foreign-line';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { SodService } from '@/modules/rbac/sod.service';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  vendorPayments,
  vendors,
  vendorBills,
  journalEntries,
  journalLines,
  vendorPaymentAllocations,
  type VendorPayment,
} from '@/database/schema';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { ApConfigService } from './ap-config.service';
import { discountAvailable } from './payables.logic';
import { validateAllocations } from '@/modules/subledger/subledger.logic';
import { VendorsService } from './vendors.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { FxService } from '@/modules/fx/fx.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { businessToday } from '@/common/time/clock';
import { BillsService, type AllocationView } from './bills.service';

const MODULE = 'PAYABLES';

export interface VendorPaymentView extends VendorPayment {
  vendorCode: string;
  vendorName: string;
  cashAccountCode: string;
  cashAccountName: string;
  journalNumber: string | null;
  unallocatedAmount: string;
}

export interface VendorPaymentDetail extends VendorPaymentView {
  allocations: AllocationView[];
}

/**
 * Vendor payments and refunds. A payment is drafted with its intended
 * allocations, then posted: the ledger entry (Dr AP / Cr cash, mirrored for
 * refunds received from the vendor) and the settlement of the targeted bills happen in one
 * transaction. Voiding reverses both.
 */
@Injectable()
export class VendorPaymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly vendorsService: VendorsService,
    private readonly billsService: BillsService,
    private readonly rates: ExchangeRatesService,
    private readonly fx: FxService,
    private readonly approvals: ApprovalsService,
    private readonly sod: SodService,
    private readonly authority: AuthorityService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: ApConfigService,
  ) {}

  /** Discounts taken alongside a payment's allocations, per bill (Prompt #7). */
  private async discountRows(tx: DbExecutor, paymentId: string) {
    return tx
      .select()
      .from(vendorPaymentAllocations)
      .where(eq(vendorPaymentAllocations.discountPaymentId, paymentId));
  }

  async list(
    companyId: string,
    query: ListPaymentsQuery,
  ): Promise<PaginatedResult<VendorPaymentView>> {
    const filters: SQL[] = [eq(vendorPayments.companyId, companyId)];
    if (query.partyId) filters.push(eq(vendorPayments.vendorId, query.partyId));
    if (query.status) filters.push(eq(vendorPayments.status, query.status));
    if (query.from) filters.push(gte(vendorPayments.paymentDate, query.from));
    if (query.to) filters.push(lte(vendorPayments.paymentDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(vendorPayments.documentNumber, term),
          ilike(vendorPayments.reference, term),
          ilike(vendors.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'amount'
        ? vendorPayments.amount
        : query.sortBy === 'documentNumber'
          ? vendorPayments.documentNumber
          : vendorPayments.paymentDate;
    const [rows, countRows] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc' ? asc(sortColumn) : desc(sortColumn),
          desc(vendorPayments.documentNumber),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(vendorPayments)
        .innerJoin(vendors, eq(vendors.id, vendorPayments.vendorId))
        .where(where),
    ]);
    return toPaginatedResult(rows.map(decorate), Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<VendorPaymentDetail> {
    const [row] = await this.viewQuery().where(
      and(eq(vendorPayments.id, id), eq(vendorPayments.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Vendor payment', id);
    const allocations = await this.db
      .select({
        id: vendorPaymentAllocations.id,
        amount: vendorPaymentAllocations.amount,
        allocationDate: vendorPaymentAllocations.allocationDate,
        paymentId: vendorPaymentAllocations.paymentId,
        paymentNumber: sql<string | null>`${vendorPayments.documentNumber}`,
        creditNoteId: vendorPaymentAllocations.creditNoteId,
        creditNoteNumber: sql<string | null>`null`,
        billId: vendorPaymentAllocations.billId,
        billNumber: vendorBills.documentNumber,
      })
      .from(vendorPaymentAllocations)
      .innerJoin(vendorBills, eq(vendorBills.id, vendorPaymentAllocations.billId))
      .innerJoin(vendorPayments, eq(vendorPayments.id, vendorPaymentAllocations.paymentId))
      .where(eq(vendorPaymentAllocations.paymentId, id))
      .orderBy(asc(vendorPaymentAllocations.createdAt));
    return { ...decorate(row), allocations };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePaymentInput,
  ): Promise<VendorPaymentDetail> {
    const id = await this.db.transaction((tx) => this.createInTx(tx, companyId, actor, input));
    return this.get(companyId, id);
  }

  /**
   * Creates the payment inside the caller's transaction (payment runs create
   * one payment per vendor this way). `options.paymentRunId` links it to the
   * run; discounts on allocations become discount allocation rows that are
   * validated and posted with the payment.
   */
  async createInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePaymentInput,
    options: { paymentRunId?: string } = {},
  ): Promise<string> {
    {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: vendorPayments.id })
          .from(vendorPayments)
          .where(
            and(
              eq(vendorPayments.companyId, companyId),
              eq(vendorPayments.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const vendor = await this.vendorsService.assertUsable(
        companyId,
        input.partyId,
        tx,
        'payment',
      );
      const currency = vendor.currency;
      const { rate: exchangeRate, baseCurrency } = await this.rates.documentRate(
        companyId,
        currency,
        input.paymentDate,
        input.exchangeRate,
        tx,
      );
      await this.assertCashAccount(companyId, input.cashAccountId, currency, baseCurrency, tx);
      await this.posting.resolvePeriod(tx, companyId, input.paymentDate, { draft: true });
      const amount = Money.parse(input.amount, currency);
      if (input.paymentType === 'REFUND' && input.allocations.length > 0) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Refunds return unapplied credit and cannot be allocated to vendorBills.',
        );
      }
      // Draft allocations are validated now for a good user experience and again strictly at posting time.
      const targets = await this.billsService.lockTargets(
        tx,
        companyId,
        input.allocations.map((a) => a.documentId),
      );
      validateAllocations(input.allocations, targets, vendor.id, amount, currency);
      const discounts = await this.validateDiscounts(
        tx,
        input.allocations,
        targets,
        input.paymentDate,
        currency,
      );
      const documentNumber = await this.numbering.allocate(
        companyId,
        'PAY',
        Number(input.paymentDate.slice(0, 4)),
        tx,
        { branchId: input.branchId ?? null },
      );

      const [created] = await tx
        .insert(vendorPayments)
        .values({
          companyId,
          vendorId: vendor.id,
          branchId: input.branchId ?? null,
          documentNumber,
          paymentType: input.paymentType,
          paymentDate: input.paymentDate,
          amount: amount.toString(),
          method: input.method,
          cashAccountId: input.cashAccountId,
          reference: input.reference ?? null,
          externalReference: input.externalReference ?? null,
          memo: input.memo ?? null,
          currency,
          exchangeRate,
          baseAmount: amount.convert(baseCurrency, exchangeRate).toString(),
          controlBaseAmount: amount.convert(baseCurrency, exchangeRate).toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          paymentRunId: options.paymentRunId ?? null,
          discountAmount: discounts.total.toString(),
          createdBy: actor.id,
        })
        .returning();
      if (!created) throw new Error('Insert returned no row');
      if (input.allocations.length > 0) {
        await tx.insert(vendorPaymentAllocations).values(
          input.allocations.map((a) => ({
            companyId,
            billId: a.documentId,
            paymentId: created.id,
            amount: Money.parse(a.amount, currency).toString(),
            allocationDate: input.paymentDate,
            createdBy: actor.id,
          })),
        );
      }
      if (discounts.rows.length > 0) {
        await tx.insert(vendorPaymentAllocations).values(
          discounts.rows.map((d) => ({
            companyId,
            billId: d.billId,
            discountPaymentId: created.id,
            amount: d.amount,
            allocationDate: input.paymentDate,
            createdBy: actor.id,
          })),
        );
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: created.id,
          newValue: {
            documentNumber,
            amount: created.amount,
            paymentType: created.paymentType,
            allocations: input.allocations.length,
            discountAmount: discounts.total.toString(),
            paymentRunId: options.paymentRunId ?? null,
          },
          companyId,
        },
        tx,
      );
      return created.id;
    }
  }

  /**
   * Early-payment discounts requested on allocations: each must be available
   * on the payment date and, together with the cash part, must not exceed the
   * bill's open balance.
   */
  private async validateDiscounts(
    tx: DbExecutor,
    allocations: CreatePaymentInput['allocations'],
    targets: Map<
      string,
      { id: string; documentNumber: string; total: string; allocatedAmount: string }
    >,
    paymentDate: string,
    currency: string,
  ): Promise<{ rows: Array<{ billId: string; amount: string }>; total: Money }> {
    const rows: Array<{ billId: string; amount: string }> = [];
    let total = Money.zero(currency);
    const wanted = allocations.filter((a) => a.discount && Number(a.discount) > 0);
    if (wanted.length === 0) return { rows, total };
    const bills = await tx
      .select({
        id: vendorBills.id,
        discountDate: vendorBills.discountDate,
        discountAmount: vendorBills.discountAmount,
        discountTakenAmount: vendorBills.discountTakenAmount,
        total: vendorBills.total,
        allocatedAmount: vendorBills.allocatedAmount,
      })
      .from(vendorBills)
      .where(
        inArray(
          vendorBills.id,
          wanted.map((a) => a.documentId),
        ),
      );
    const byId = new Map(bills.map((b) => [b.id, b]));
    for (const a of wanted) {
      const bill = byId.get(a.documentId);
      const target = targets.get(a.documentId);
      if (!bill || !target) continue;
      const discount = Money.parse(a.discount!, currency);
      const available = discountAvailable(bill, paymentDate, currency);
      if (discount.greaterThan(available))
        throw new BusinessRuleError(
          ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
          `${target.documentNumber}: discount ${discount.toString()} exceeds the ${available.toString()} available on ${paymentDate}.`,
          { documentId: a.documentId, discountAvailable: available.toString() },
        );
      const open = Money.of(target.total, currency).subtract(
        Money.of(target.allocatedAmount, currency),
      );
      if (Money.parse(a.amount, currency).add(discount).greaterThan(open))
        throw new BusinessRuleError(
          ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
          `${target.documentNumber}: payment plus discount exceed the open balance ${open.toString()}.`,
          { documentId: a.documentId, remaining: open.toString() },
        );
      rows.push({ billId: a.documentId, amount: discount.toString() });
      total = total.add(discount);
    }
    return { rows, total };
  }

  /** DRAFT -> SUBMITTED: opens the approval workflow and tells approvers (Prompt #7). */
  async submit(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<VendorPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      await this.approvals.open(tx, this.workflowRef(companyId, existing, actor.id));
      await tx
        .update(vendorPayments)
        .set({ status: 'SUBMITTED', submittedBy: actor.id, submittedAt: new Date() })
        .where(eq(vendorPayments.id, id));
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'SUBMITTED' },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      await this.notifyOrg(tx, companyId, {
        eventType: 'VENDOR_PAYMENT_APPROVAL_REQUIRED',
        title: `Vendor payment ${existing.documentNumber} awaits approval`,
        body: `${existing.currency} ${existing.amount} submitted for approval by ${actor.email}.`,
        link: `/purchasing/payments/${id}`,
        entityId: id,
        permission: P['vendor-payment.approve'],
      });
    });
    return this.get(companyId, id);
  }

  /** Explicit approval step (delegable `vendor-payment.approve`, SoD against the creator). */
  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<VendorPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT' && existing.status !== 'SUBMITTED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      await this.approvals.assertApproved(
        tx,
        this.workflowRef(companyId, existing, existing.createdBy ?? actor.id),
      );
      const authority = await this.authority.assert(tx, actor, P['vendor-payment.approve'], {
        companyId,
        branchId: existing.branchId,
        amount: existing.amount,
        currency: existing.currency,
        documentType: 'VENDOR_PAYMENT',
        documentId: id,
        documentNumber: existing.documentNumber,
        createdBy: existing.createdBy,
        action: 'Approved vendor payment',
      });
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['vendor-payment.create'], P['vendor-payment.approve']],
        existing.createdBy,
        actor.id,
        tx,
        {
          companyId,
          entityType: 'VendorPayment',
          entityId: id,
          documentNumber: existing.documentNumber,
        },
      );
      await tx
        .update(vendorPayments)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(vendorPayments.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: existing.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'vendor_payment.approved',
        companyId,
        dedupeKey: 'vendor_payment.approved:' + id,
        payload: this.eventPayload(existing, 'APPROVED'),
      });
    });
    return this.get(companyId, id);
  }

  private workflowRef(companyId: string, doc: VendorPayment, requestedBy: string) {
    return {
      companyId,
      documentType: 'VENDOR_PAYMENT' as const,
      documentId: doc.id,
      documentNumber: doc.documentNumber,
      amount: doc.amount,
      currency: doc.currency,
      requestedBy,
      branchId: doc.branchId,
    };
  }

  private eventPayload(doc: VendorPayment, status: string) {
    return {
      paymentId: doc.id,
      documentNumber: doc.documentNumber,
      vendorId: doc.vendorId,
      paymentType: doc.paymentType,
      paymentDate: doc.paymentDate,
      amount: doc.amount,
      discountAmount: doc.discountAmount,
      currency: doc.currency,
      method: doc.method,
      paymentRunId: doc.paymentRunId,
      status,
    };
  }

  private async notifyOrg(
    tx: DbExecutor,
    companyId: string,
    input: {
      eventType: 'VENDOR_PAYMENT_APPROVAL_REQUIRED';
      title: string;
      body: string;
      link: string;
      entityId: string;
      permission?: string;
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
        link: input.link,
        entityType: 'VendorPayment',
        entityId: input.entityId,
        permission: input.permission,
        companyId,
        dedupeKey: `${input.eventType}:${input.entityId}`,
      },
      tx,
    );
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePaymentInput,
  ): Promise<VendorPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status} and cannot be edited.`,
        );
      const vendorId = input.partyId ?? existing.vendorId;
      const vendor = await this.vendorsService.getOrThrow(companyId, vendorId, tx);
      const paymentDate = input.paymentDate ?? existing.paymentDate;
      await this.posting.resolvePeriod(tx, companyId, paymentDate, { draft: true });
      if (input.cashAccountId)
        await this.assertCashAccount(
          companyId,
          input.cashAccountId,
          existing.currency,
          await this.accounts.companyCurrency(companyId, tx),
          tx,
        );
      if (vendor.currency !== existing.currency) {
        throw new BusinessRuleError(
          ErrorCodes.CURRENCY_MISMATCH,
          `${existing.documentNumber} is in ${existing.currency}; the vendor settles in ${vendor.currency}.`,
        );
      }
      const amount = input.amount
        ? Money.parse(input.amount, existing.currency)
        : Money.of(existing.amount, existing.currency);
      const rateChanged = input.exchangeRate !== undefined || input.paymentDate !== undefined;
      const { rate: exchangeRate, baseCurrency } = rateChanged
        ? await this.rates.documentRate(
            companyId,
            existing.currency,
            paymentDate,
            input.exchangeRate,
            tx,
          )
        : {
            rate: existing.exchangeRate,
            baseCurrency: await this.accounts.companyCurrency(companyId, tx),
          };
      const paymentType = input.paymentType ?? existing.paymentType;
      if (input.allocations) {
        if (paymentType === 'REFUND' && input.allocations.length > 0)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'Refunds cannot be allocated to vendorBills.',
          );
        const targets = await this.billsService.lockTargets(
          tx,
          companyId,
          input.allocations.map((a) => a.documentId),
        );
        validateAllocations(input.allocations, targets, vendor.id, amount, existing.currency);
        await tx.delete(vendorPaymentAllocations).where(eq(vendorPaymentAllocations.paymentId, id));
        if (input.allocations.length > 0) {
          await tx.insert(vendorPaymentAllocations).values(
            input.allocations.map((a) => ({
              companyId,
              billId: a.documentId,
              paymentId: id,
              amount: Money.parse(a.amount, existing.currency).toString(),
              allocationDate: paymentDate,
              createdBy: actor.id,
            })),
          );
        }
      }
      await tx
        .update(vendorPayments)
        .set({
          vendorId: vendor.id,
          paymentType,
          paymentDate,
          amount: amount.toString(),
          exchangeRate,
          baseAmount: amount.convert(baseCurrency, exchangeRate).toString(),
          controlBaseAmount: amount.convert(baseCurrency, exchangeRate).toString(),
          method: input.method ?? existing.method,
          cashAccountId: input.cashAccountId ?? existing.cashAccountId,
          reference: input.reference === undefined ? existing.reference : input.reference,
          memo: input.memo === undefined ? existing.memo : input.memo,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
        })
        .where(eq(vendorPayments.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: id,
          previousValue: { amount: existing.amount },
          newValue: { amount: amount.toString() },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Only draft payments can be deleted; posted payments must be voided.',
        );
      await tx.delete(vendorPaymentAllocations).where(eq(vendorPaymentAllocations.paymentId, id));
      await tx.delete(vendorPayments).where(eq(vendorPayments.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber, amount: existing.amount },
          companyId,
        },
        tx,
      );
    });
  }

  /** Posts Dr cash / Cr AR (refund: Dr AR / Cr cash) and settles the allocated vendorBills. Idempotent. */
  async post(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<VendorPaymentDetail> {
    await this.db.transaction((tx) => this.postInTx(tx, companyId, actor, id));
    return this.get(companyId, id);
  }

  /**
   * Posts inside the caller's transaction. `approvedUpstream` lets an approved
   * payment run post the payments it created without a second approval.
   */
  async postInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    options: { approvedUpstream?: boolean } = {},
  ): Promise<void> {
    {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'POSTED') return;
      if (existing.status !== 'DRAFT' && existing.status !== 'APPROVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      // Policy: payments may require an explicit approval step and / or a workflow (Prompt #7).
      const settings = await this.config.settings(companyId, tx);
      if (!options.approvedUpstream) {
        if (settings.requirePaymentApproval && existing.status !== 'APPROVED')
          throw new BusinessRuleError(
            ErrorCodes.APPROVAL_REQUIRED,
            `${existing.documentNumber} must be approved before it is posted.`,
          );
        await this.approvals.assertApproved(
          tx,
          this.workflowRef(companyId, existing, existing.createdBy ?? actor.id),
        );
      }
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['vendor-payment.create'], P['vendor-payment.post']],
        existing.createdBy,
        actor.id,
        tx,
        {
          companyId,
          entityType: 'VendorPayment',
          entityId: id,
          documentNumber: existing.documentNumber,
        },
      );
      const currency = existing.currency;
      const amount = Money.of(existing.amount, currency);
      const draftAllocations = await tx
        .select()
        .from(vendorPaymentAllocations)
        .where(eq(vendorPaymentAllocations.paymentId, id));
      const discountRows = await this.discountRows(tx, id);
      const targets = await this.billsService.lockTargets(tx, companyId, [
        ...new Set([...draftAllocations, ...discountRows].map((a) => a.billId)),
      ]);
      const allocated = validateAllocations(
        draftAllocations.map((a) => ({ documentId: a.billId, amount: a.amount })),
        targets,
        existing.vendorId,
        amount,
        currency,
      );
      // Discounts are re-validated strictly at posting time against today's window and balances.
      const discounts = await this.validateDiscounts(
        tx,
        draftAllocations.map((a) => ({
          documentId: a.billId,
          amount: a.amount,
          discount: discountRows.find((d) => d.billId === a.billId)?.amount,
        })),
        targets,
        existing.paymentDate,
        currency,
      );
      const discountBase = discounts.total.convert(
        await this.accounts.companyCurrency(companyId, tx),
        existing.exchangeRate,
      );

      if (existing.paymentType === 'REFUND') {
        const balances = await this.vendorsService.balances(companyId, [existing.vendorId], tx);
        const credit = Money.of(balances.get(existing.vendorId)!.unappliedCredit, currency);
        if (amount.greaterThan(credit)) {
          throw new BusinessRuleError(
            ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
            `Refund ${amount.toString()} exceeds the vendor's unapplied credit ${credit.toString()}.`,
            { unappliedCredit: credit.toString() },
          );
        }
      }

      const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_PAYABLE', tx);
      // Disbursement: Dr AP / Cr cash. Refund received from the vendor: Dr cash / Cr AP.
      const isDisbursement = existing.paymentType === 'PAYMENT';
      // Base amounts: the bank side at the payment rate; the control side at each bill's rate.
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const baseAmount = amount.convert(baseCurrency, existing.exchangeRate);
      const cashAccount = await this.accounts.getOrThrow(companyId, existing.cashAccountId, tx);
      // A foreign-currency bank account's line also carries the payment in its own currency.
      const cashForeign = foreignLineFields(
        cashAccount,
        baseCurrency,
        {
          currency: existing.currency,
          amount: amount.toString(),
          exchangeRate: existing.exchangeRate,
        },
        isDisbursement ? 'credit' : 'debit',
      );
      const gain = isDisbursement
        ? this.fx.settlementGain(
            draftAllocations.map((a) => ({
              amount: a.amount,
              currency,
              documentRate: targets.get(a.billId)!.exchangeRate,
            })),
            existing.exchangeRate,
            baseCurrency,
            'AP',
          )
        : Money.zero(baseCurrency);
      // AP: bank pays baseAmount; the payable relieved is baseAmount + gain (+ discount taken).
      const controlBase = baseAmount.add(gain).add(discountBase);
      const fxLines = await this.fx.realizedLines(tx, companyId, gain);
      const discountLines = discountBase.isPositive()
        ? [
            {
              accountId: (await this.accounts.resolveMapped(companyId, 'PURCHASE_DISCOUNT', tx)).id,
              debit: '0',
              credit: discountBase.toString(),
              description: `${existing.documentNumber} - early-payment discount taken`,
            },
          ]
        : [];
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: existing.paymentDate,
          description: `${isDisbursement ? 'Vendor payment' : 'Vendor refund'} ${existing.documentNumber}${existing.memo ? ` - ${existing.memo}` : ''}`,
          reference: existing.reference ?? existing.documentNumber,
          branchId: existing.branchId,
          sourceType: 'AP_PAYMENT',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: control.id,
              debit: isDisbursement ? controlBase.toString() : '0',
              credit: isDisbursement ? '0' : controlBase.toString(),
              description: `${existing.documentNumber} - vendor payable`,
            },
            {
              accountId: existing.cashAccountId,
              debit: isDisbursement ? '0' : baseAmount.toString(),
              credit: isDisbursement ? baseAmount.toString() : '0',
              description: `${existing.documentNumber} ${existing.method.toLowerCase().replace('_', ' ')}`,
              ...cashForeign,
            },
            ...discountLines,
            ...fxLines,
          ],
        },
        { permission: P['vendor-payment.post'] },
      );

      await this.billsService.applyToTargets(
        tx,
        targets,
        [
          ...draftAllocations.map((a) => ({ documentId: a.billId, amount: a.amount })),
          ...discounts.rows.map((d) => ({ documentId: d.billId, amount: d.amount })),
        ],
        currency,
      );
      for (const d of discounts.rows)
        await tx
          .update(vendorBills)
          .set({ discountTakenAmount: sql`${vendorBills.discountTakenAmount} + ${d.amount}` })
          .where(eq(vendorBills.id, d.billId));
      await tx
        .update(vendorPaymentAllocations)
        .set({ allocationDate: existing.paymentDate })
        .where(
          or(
            eq(vendorPaymentAllocations.paymentId, id),
            eq(vendorPaymentAllocations.discountPaymentId, id),
          ),
        );
      await tx
        .update(vendorPayments)
        .set({
          status: 'POSTED',
          allocatedAmount: allocated.toString(),
          baseAmount: baseAmount.toString(),
          controlBaseAmount: controlBase.toString(),
          discountAmount: discounts.total.toString(),
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(vendorPayments.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: id,
          newValue: {
            status: 'POSTED',
            journalEntryId: entry.id,
            allocated: allocated.toString(),
            discountTaken: discounts.total.toString(),
          },
          metadata: {
            documentNumber: existing.documentNumber,
            journalNumber: entry.documentNumber,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'vendor_payment.posted',
        companyId,
        dedupeKey: 'vendor_payment.posted:' + id,
        payload: {
          ...this.eventPayload(existing, 'POSTED'),
          allocated: allocated.toString(),
          discountAmount: discounts.total.toString(),
          journalEntryId: entry.id,
          journalNumber: entry.documentNumber,
        },
      });
    }
  }

  /** Applies the unallocated part of a posted receipt to open bills (no new ledger entry). */
  async allocate(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: AllocateInput,
    allocationDate = businessToday(),
  ): Promise<VendorPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'POSTED' || existing.paymentType !== 'PAYMENT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Only posted vendor payments can be allocated.',
        );
      const currency = existing.currency;
      const available = Money.of(existing.amount, currency).subtract(
        Money.of(existing.allocatedAmount, currency),
      );
      const targets = await this.billsService.lockTargets(
        tx,
        companyId,
        input.allocations.map((a) => a.documentId),
      );
      const applied = validateAllocations(
        input.allocations,
        targets,
        existing.vendorId,
        available,
        currency,
      );
      const inserted = await tx
        .insert(vendorPaymentAllocations)
        .values(
          input.allocations.map((a) => ({
            companyId,
            billId: a.documentId,
            paymentId: id,
            amount: Money.parse(a.amount, currency).toString(),
            allocationDate,
            createdBy: actor.id,
          })),
        )
        .returning({ id: vendorPaymentAllocations.id });
      await this.billsService.applyToTargets(tx, targets, input.allocations, currency);
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const gain = this.fx.settlementGain(
        input.allocations.map((a) => ({
          amount: a.amount,
          currency,
          documentRate: targets.get(a.documentId)!.exchangeRate,
        })),
        existing.exchangeRate,
        baseCurrency,
        'AP',
      );
      await this.fx.postRealizedGain(tx, {
        companyId,
        side: 'AP',
        entryDate: allocationDate,
        gain,
        baseCurrency,
        description: `Realized FX on allocating ${existing.documentNumber}`,
        sourceType: 'AP_PAYMENT_ALLOCATION',
        sourceId: existing.id,
        eventId: inserted[0]!.id,
        actor,
        permission: P['vendor-payment.post'],
        branchId: existing.branchId,
      });
      await tx
        .update(vendorPayments)
        .set({
          allocatedAmount: Money.of(existing.allocatedAmount, currency).add(applied).toString(),
        })
        .where(eq(vendorPayments.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: id,
          newValue: { applied: applied.toString(), allocations: input.allocations },
          metadata: { documentNumber: existing.documentNumber, kind: 'allocation' },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Reverses the ledger entry and releases every allocation. */
  async void(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VoidDocumentInput,
  ): Promise<VendorPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'POSTED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is not posted.`,
        );
      const allocations = await tx
        .select()
        .from(vendorPaymentAllocations)
        .where(eq(vendorPaymentAllocations.paymentId, id));
      const discountRows = await this.discountRows(tx, id);
      await this.billsService.releaseFromTargets(
        tx,
        companyId,
        [...allocations, ...discountRows],
        existing.currency,
      );
      for (const d of discountRows)
        await tx
          .update(vendorBills)
          .set({ discountTakenAmount: sql`${vendorBills.discountTakenAmount} - ${d.amount}` })
          .where(eq(vendorBills.id, d.billId));
      await tx
        .delete(vendorPaymentAllocations)
        .where(
          or(
            eq(vendorPaymentAllocations.paymentId, id),
            eq(vendorPaymentAllocations.discountPaymentId, id),
          ),
        );
      await this.fx.reverseRealized(
        tx,
        companyId,
        'AP_PAYMENT_ALLOCATION',
        existing.id,
        input.reversalDate ?? existing.paymentDate,
        actor,
        P['vendor-payment.post'],
      );

      const originalLines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, existing.journalEntryId!))
        .orderBy(asc(journalLines.lineNumber));
      const reversal = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.reversalDate ?? existing.paymentDate,
          description: `Void ${existing.documentNumber}: ${input.reason}`,
          reference: existing.documentNumber,
          journalType: 'REVERSAL',
          branchId: existing.branchId,
          sourceType: 'AP_PAYMENT_VOID',
          sourceId: existing.id,
          reversalOfId: existing.journalEntryId,
          actor,
          lines: originalLines.map((l) => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            description: l.description,
            branchId: l.branchId,
          })),
        },
        { permission: P['vendor-payment.post'] },
      );
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, existing.journalEntryId!));
      await tx
        .update(vendorPayments)
        .set({
          status: 'VOID',
          allocatedAmount: '0',
          reversalJournalEntryId: reversal.id,
          voidReason: input.reason,
          voidedBy: actor.id,
          voidedAt: new Date(),
        })
        .where(eq(vendorPayments.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'VendorPayment',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: { status: 'VOID', reversalJournalEntryId: reversal.id },
          metadata: {
            documentNumber: existing.documentNumber,
            reason: input.reason,
            releasedAllocations: allocations.length,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'vendor_payment.voided',
        companyId,
        dedupeKey: 'vendor_payment.voided:' + id,
        payload: { ...this.eventPayload(existing, 'VOID'), reason: input.reason },
      });
    });
    return this.get(companyId, id);
  }

  // --------------------------------------------------------------- internals

  private viewQuery() {
    const cash = sql<string>`(select code from accounts a where a.id = ${vendorPayments.cashAccountId})`;
    const cashName = sql<string>`(select name from accounts a where a.id = ${vendorPayments.cashAccountId})`;
    return this.db
      .select({
        ...getTableColumns(vendorPayments),
        vendorCode: vendors.code,
        vendorName: vendors.name,
        cashAccountCode: cash,
        cashAccountName: cashName,
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${vendorPayments.journalEntryId})`,
      })
      .from(vendorPayments)
      .innerJoin(vendors, eq(vendors.id, vendorPayments.vendorId));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<VendorPayment> {
    const [row] = await tx
      .select()
      .from(vendorPayments)
      .where(and(eq(vendorPayments.id, id), eq(vendorPayments.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Vendor payment', id);
    return row;
  }

  private async assertCashAccount(
    companyId: string,
    accountId: string,
    currency: string,
    baseCurrency: string,
    tx: DbExecutor,
  ): Promise<void> {
    const account = await this.accounts.getOrThrow(companyId, accountId, tx);
    if (account.isHeader || account.status !== 'ACTIVE' || account.type !== 'ASSET') {
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNT_NOT_POSTABLE,
        `${account.code} ${account.name} is not a usable cash or bank account.`,
      );
    }
    assertAccountTakesCurrency(account, baseCurrency, currency);
  }
}

function decorate<T extends VendorPayment>(row: T): T & { unallocatedAmount: string } {
  const unallocated =
    row.status === 'POSTED'
      ? Money.of(row.amount, row.currency)
          .subtract(Money.of(row.allocatedAmount, row.currency))
          .toString()
      : '0.0000';
  return { ...row, unallocatedAmount: unallocated };
}
