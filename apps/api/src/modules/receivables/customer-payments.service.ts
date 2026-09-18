import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
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
  customerPayments,
  customers,
  invoices,
  journalEntries,
  journalLines,
  paymentAllocations,
  type CustomerPayment,
} from '@/database/schema';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { ArConfigService } from './ar-config.service';
import { validateAllocations } from '@/modules/subledger/subledger.logic';
import { CustomersService } from './customers.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { FxService } from '@/modules/fx/fx.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { InvoicesService, type AllocationView } from './invoices.service';

const MODULE = 'RECEIVABLES';

export interface CustomerPaymentView extends CustomerPayment {
  customerCode: string;
  customerName: string;
  cashAccountCode: string;
  cashAccountName: string;
  journalNumber: string | null;
  unallocatedAmount: string;
  /** UNALLOCATED / PARTIALLY_ALLOCATED / ALLOCATED for posted receipts. */
  allocationStatus: 'UNALLOCATED' | 'PARTIALLY_ALLOCATED' | 'ALLOCATED' | null;
}

export interface CustomerPaymentDetail extends CustomerPaymentView {
  allocations: AllocationView[];
}

/**
 * Customer receipts and refunds. A payment is drafted with its intended
 * allocations, then posted: the ledger entry (Dr cash / Cr AR, mirrored for
 * refunds) and the settlement of the targeted invoices happen in one
 * transaction. Voiding reverses both.
 */
@Injectable()
export class CustomerPaymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly customersService: CustomersService,
    private readonly invoicesService: InvoicesService,
    private readonly rates: ExchangeRatesService,
    private readonly fx: FxService,
    private readonly outbox: OutboxService,
    private readonly sod: SodService,
    private readonly authority: AuthorityService,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationsService,
    private readonly config: ArConfigService,
  ) {}

  async list(
    companyId: string,
    query: ListPaymentsQuery,
  ): Promise<PaginatedResult<CustomerPaymentView>> {
    const filters: SQL[] = [eq(customerPayments.companyId, companyId)];
    if (query.partyId) filters.push(eq(customerPayments.customerId, query.partyId));
    if (query.status) filters.push(eq(customerPayments.status, query.status));
    if (query.paymentType) filters.push(eq(customerPayments.paymentType, query.paymentType));
    if (query.from) filters.push(gte(customerPayments.paymentDate, query.from));
    if (query.to) filters.push(lte(customerPayments.paymentDate, query.to));
    if (query.unappliedOnly)
      filters.push(
        eq(customerPayments.status, 'POSTED'),
        eq(customerPayments.paymentType, 'PAYMENT'),
        sql`${customerPayments.allocatedAmount} < ${customerPayments.amount}`,
      );
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(customerPayments.documentNumber, term),
          ilike(customerPayments.reference, term),
          ilike(customerPayments.externalReference, term),
          ilike(customers.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'amount'
        ? customerPayments.amount
        : query.sortBy === 'documentNumber'
          ? customerPayments.documentNumber
          : customerPayments.paymentDate;
    const [rows, countRows] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc' ? asc(sortColumn) : desc(sortColumn),
          desc(customerPayments.documentNumber),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(customerPayments)
        .innerJoin(customers, eq(customers.id, customerPayments.customerId))
        .where(where),
    ]);
    return toPaginatedResult(rows.map(decorate), Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<CustomerPaymentDetail> {
    const [row] = await this.viewQuery().where(
      and(eq(customerPayments.id, id), eq(customerPayments.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Customer payment', id);
    const allocations = await this.db
      .select({
        id: paymentAllocations.id,
        amount: paymentAllocations.amount,
        allocationDate: paymentAllocations.allocationDate,
        paymentId: paymentAllocations.paymentId,
        paymentNumber: sql<string | null>`${customerPayments.documentNumber}`,
        creditNoteId: paymentAllocations.creditNoteId,
        creditNoteNumber: sql<string | null>`null`,
        invoiceId: paymentAllocations.invoiceId,
        invoiceNumber: invoices.documentNumber,
      })
      .from(paymentAllocations)
      .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.paymentId))
      .where(eq(paymentAllocations.paymentId, id))
      .orderBy(asc(paymentAllocations.createdAt));
    return { ...decorate(row), allocations };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePaymentInput,
  ): Promise<CustomerPaymentDetail> {
    const id = await this.db.transaction((tx) => this.createInTx(tx, companyId, actor, input));
    return this.get(companyId, id);
  }

  /** Drafting inside a caller transaction; returns the payment id. */
  async createInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePaymentInput,
  ): Promise<string> {
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select({ id: customerPayments.id })
        .from(customerPayments)
        .where(
          and(
            eq(customerPayments.companyId, companyId),
            eq(customerPayments.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing) return existing.id;
    }
    const customer = await this.customersService.getOrThrow(companyId, input.partyId, tx);
    if (customer.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.PARTY_INACTIVE,
        `Customer ${customer.code} is inactive.`,
      );
    const currency = customer.currency;
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
        'Refunds return unapplied credit and cannot be allocated to invoices.',
      );
    }
    // Draft allocations are validated now for a good user experience and again strictly at posting time.
    const targets = await this.invoicesService.lockTargets(
      tx,
      companyId,
      input.allocations.map((a) => a.documentId),
    );
    validateAllocations(input.allocations, targets, customer.id, amount, currency);
    const documentNumber = await this.numbering.allocate(
      companyId,
      'RCP',
      Number(input.paymentDate.slice(0, 4)),
      tx,
      { branchId: input.branchId ?? null },
    );

    const [created] = await tx
      .insert(customerPayments)
      .values({
        companyId,
        customerId: customer.id,
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
        createdBy: actor.id,
      })
      .returning();
    if (!created) throw new Error('Insert returned no row');
    if (input.allocations.length > 0) {
      await tx.insert(paymentAllocations).values(
        input.allocations.map((a) => ({
          companyId,
          invoiceId: a.documentId,
          paymentId: created.id,
          amount: Money.parse(a.amount, currency).toString(),
          allocationDate: input.paymentDate,
          createdBy: actor.id,
        })),
      );
    }
    await this.audit.record(
      {
        action: 'CREATE',
        module: MODULE,
        entityType: 'CustomerPayment',
        entityId: created.id,
        newValue: {
          documentNumber,
          amount: created.amount,
          paymentType: created.paymentType,
          allocations: input.allocations.length,
        },
        companyId,
      },
      tx,
    );
    await this.outbox.enqueue(tx, {
      eventType: 'payment.created',
      companyId,
      dedupeKey: 'payment.created:' + created.id,
      payload: {
        paymentId: created.id,
        documentNumber,
        customerId: created.customerId,
        paymentType: created.paymentType,
        paymentDate: created.paymentDate,
        amount: created.amount,
        currency: created.currency,
        status: 'DRAFT',
      },
    });
    return created.id;
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePaymentInput,
  ): Promise<CustomerPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status} and cannot be edited.`,
        );
      const customerId = input.partyId ?? existing.customerId;
      const customer = await this.customersService.getOrThrow(companyId, customerId, tx);
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
      if (customer.currency !== existing.currency) {
        throw new BusinessRuleError(
          ErrorCodes.CURRENCY_MISMATCH,
          `${existing.documentNumber} is in ${existing.currency}; the party settles in ${customer.currency}.`,
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
            'Refunds cannot be allocated to invoices.',
          );
        const targets = await this.invoicesService.lockTargets(
          tx,
          companyId,
          input.allocations.map((a) => a.documentId),
        );
        validateAllocations(input.allocations, targets, customer.id, amount, existing.currency);
        await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, id));
        if (input.allocations.length > 0) {
          await tx.insert(paymentAllocations).values(
            input.allocations.map((a) => ({
              companyId,
              invoiceId: a.documentId,
              paymentId: id,
              amount: Money.parse(a.amount, existing.currency).toString(),
              allocationDate: paymentDate,
              createdBy: actor.id,
            })),
          );
        }
      }
      await tx
        .update(customerPayments)
        .set({
          customerId: customer.id,
          paymentType,
          paymentDate,
          amount: amount.toString(),
          exchangeRate,
          baseAmount: amount.convert(baseCurrency, exchangeRate).toString(),
          controlBaseAmount: amount.convert(baseCurrency, exchangeRate).toString(),
          method: input.method ?? existing.method,
          cashAccountId: input.cashAccountId ?? existing.cashAccountId,
          reference: input.reference === undefined ? existing.reference : input.reference,
          externalReference:
            input.externalReference === undefined
              ? existing.externalReference
              : input.externalReference,
          memo: input.memo === undefined ? existing.memo : input.memo,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
        })
        .where(eq(customerPayments.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CustomerPayment',
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
      await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, id));
      await tx.delete(customerPayments).where(eq(customerPayments.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'CustomerPayment',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber, amount: existing.amount },
          companyId,
        },
        tx,
      );
    });
  }

  /** Posts Dr cash / Cr AR (refund: Dr AR / Cr cash) and settles the allocated invoices. Idempotent. */
  async post(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<CustomerPaymentDetail> {
    await this.db.transaction((tx) => this.postInTx(tx, companyId, actor, id));
    return this.get(companyId, id);
  }

  /** Posting inside a caller transaction (refund requests pay through here). */
  async postInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    options: { approvedUpstream?: boolean } = {},
  ): Promise<void> {
    const existing = await this.lock(tx, companyId, id);
    if (existing.status === 'POSTED') return;
    if (existing.status !== 'DRAFT' && existing.status !== 'APPROVED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${existing.documentNumber} is ${existing.status}.`,
      );
    // Policy: payments may require an explicit approval step and / or a workflow (Prompt #6).
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
      [P['customer-payment.create'], P['customer-payment.post']],
      existing.createdBy,
      actor.id,
      tx,
      {
        companyId,
        entityType: 'CustomerPayment',
        entityId: id,
        documentNumber: existing.documentNumber,
      },
    );
    const currency = existing.currency;
    const amount = Money.of(existing.amount, currency);
    const draftAllocations = await tx
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, id));
    const targets = await this.invoicesService.lockTargets(
      tx,
      companyId,
      draftAllocations.map((a) => a.invoiceId),
    );
    const allocated = validateAllocations(
      draftAllocations.map((a) => ({ documentId: a.invoiceId, amount: a.amount })),
      targets,
      existing.customerId,
      amount,
      currency,
    );

    if (existing.paymentType === 'REFUND') {
      const balances = await this.customersService.balances(companyId, [existing.customerId], tx);
      const credit = Money.of(balances.get(existing.customerId)!.unappliedCredit, currency);
      if (amount.greaterThan(credit)) {
        throw new BusinessRuleError(
          ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
          `Refund ${amount.toString()} exceeds the customer's unapplied credit ${credit.toString()}.`,
          { unappliedCredit: credit.toString() },
        );
      }
    }

    const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_RECEIVABLE', tx);
    const cashAccount = await this.accounts.getOrThrow(companyId, existing.cashAccountId, tx);
    const isReceipt = existing.paymentType === 'PAYMENT';
    // Base amounts: the bank side at the payment rate; the control side at each document's rate.
    const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
    const baseAmount = amount.convert(baseCurrency, existing.exchangeRate);
    // A foreign-currency bank account's line also carries the receipt in its own currency.
    const cashForeign = foreignLineFields(
      cashAccount,
      baseCurrency,
      { currency, amount: amount.toString(), exchangeRate: existing.exchangeRate },
      isReceipt ? 'debit' : 'credit',
    );
    const gain = isReceipt
      ? this.fx.settlementGain(
          draftAllocations.map((a) => ({
            amount: a.amount,
            currency,
            documentRate: targets.get(a.invoiceId)!.exchangeRate,
          })),
          existing.exchangeRate,
          baseCurrency,
          'AR',
        )
      : Money.zero(baseCurrency);
    // AR: bank receives baseAmount; the receivable relieved is baseAmount - gain.
    const controlBase = baseAmount.subtract(gain);
    const fxLines = await this.fx.realizedLines(tx, companyId, gain);
    const entry = await this.posting.postEvent(
      tx,
      {
        companyId,
        entryDate: existing.paymentDate,
        description: `${isReceipt ? 'Customer receipt' : 'Customer refund'} ${existing.documentNumber}${existing.memo ? ` - ${existing.memo}` : ''}`,
        reference: existing.reference ?? existing.documentNumber,
        branchId: existing.branchId,
        sourceType: 'AR_PAYMENT',
        sourceId: existing.id,
        actor,
        lines: [
          {
            accountId: existing.cashAccountId,
            debit: isReceipt ? baseAmount.toString() : '0',
            credit: isReceipt ? '0' : baseAmount.toString(),
            description: `${existing.documentNumber} ${existing.method.toLowerCase().replace('_', ' ')}`,
            ...cashForeign,
          },
          {
            accountId: control.id,
            debit: isReceipt ? '0' : controlBase.toString(),
            credit: isReceipt ? controlBase.toString() : '0',
            description: `${existing.documentNumber} - customer receivable`,
          },
          ...fxLines,
        ],
      },
      { permission: P['customer-payment.post'] },
    );

    await this.invoicesService.applyToTargets(
      tx,
      targets,
      draftAllocations.map((a) => ({ documentId: a.invoiceId, amount: a.amount })),
      currency,
    );
    await tx
      .update(paymentAllocations)
      .set({ allocationDate: existing.paymentDate })
      .where(eq(paymentAllocations.paymentId, id));
    await tx
      .update(customerPayments)
      .set({
        status: 'POSTED',
        allocatedAmount: allocated.toString(),
        baseAmount: baseAmount.toString(),
        controlBaseAmount: controlBase.toString(),
        journalEntryId: entry.id,
        postedBy: actor.id,
        postedAt: new Date(),
      })
      .where(eq(customerPayments.id, id));
    await this.audit.record(
      {
        action: 'POST',
        module: MODULE,
        entityType: 'CustomerPayment',
        entityId: id,
        newValue: { status: 'POSTED', journalEntryId: entry.id, allocated: allocated.toString() },
        metadata: {
          documentNumber: existing.documentNumber,
          journalNumber: entry.documentNumber,
        },
        companyId,
      },
      tx,
    );
    await this.outbox.enqueue(tx, {
      eventType: isReceipt ? 'payment.received' : 'payment.refunded',
      companyId,
      dedupeKey: (isReceipt ? 'payment.received:' : 'payment.refunded:') + id,
      payload: {
        paymentId: id,
        documentNumber: existing.documentNumber,
        customerId: existing.customerId,
        paymentType: existing.paymentType,
        paymentDate: existing.paymentDate,
        amount: existing.amount,
        currency: existing.currency,
        allocated: allocated.toString(),
        unallocated: amount.subtract(allocated).toString(),
      },
    });
    await this.emitPaidInvoices(tx, companyId, targets, currency);
    if (isReceipt)
      await this.notifyOrg(tx, companyId, {
        eventType: 'PAYMENT_RECEIVED',
        title: `Receipt ${existing.documentNumber} posted`,
        body: `${existing.currency} ${existing.amount} received; ${amount.subtract(allocated).toString()} unapplied.`,
        link: `/receivables/payments/${id}`,
        entityId: id,
        userIds: [existing.createdBy].filter((u): u is string => Boolean(u)),
        permission: P['customer-payment.post'],
      });
    await this.outbox.enqueue(tx, {
      eventType: 'payment.completed',
      companyId,
      dedupeKey: 'payment.completed:' + id,
      payload: {
        paymentId: id,
        documentNumber: existing.documentNumber,
        customerId: existing.customerId,
        paymentType: existing.paymentType,
        paymentDate: existing.paymentDate,
        amount: existing.amount,
        currency: existing.currency,
        allocated: allocated.toString(),
        journalEntryId: entry.id,
        journalNumber: entry.documentNumber,
        status: 'POSTED',
      },
    });
  }

  /** Applies the unallocated part of a posted receipt to open invoices (no new ledger entry). */
  async allocate(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: AllocateInput,
    allocationDate = new Date().toISOString().slice(0, 10),
  ): Promise<CustomerPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'POSTED' || existing.paymentType !== 'PAYMENT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Only posted receipts can be allocated.',
        );
      const currency = existing.currency;
      const available = Money.of(existing.amount, currency).subtract(
        Money.of(existing.allocatedAmount, currency),
      );
      const targets = await this.invoicesService.lockTargets(
        tx,
        companyId,
        input.allocations.map((a) => a.documentId),
      );
      const applied = validateAllocations(
        input.allocations,
        targets,
        existing.customerId,
        available,
        currency,
      );
      const inserted = await tx
        .insert(paymentAllocations)
        .values(
          input.allocations.map((a) => ({
            companyId,
            invoiceId: a.documentId,
            paymentId: id,
            amount: Money.parse(a.amount, currency).toString(),
            allocationDate,
            createdBy: actor.id,
          })),
        )
        .returning({ id: paymentAllocations.id });
      await this.invoicesService.applyToTargets(tx, targets, input.allocations, currency);
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const gain = this.fx.settlementGain(
        input.allocations.map((a) => ({
          amount: a.amount,
          currency,
          documentRate: targets.get(a.documentId)!.exchangeRate,
        })),
        existing.exchangeRate,
        baseCurrency,
        'AR',
      );
      await this.fx.postRealizedGain(tx, {
        companyId,
        side: 'AR',
        entryDate: allocationDate,
        gain,
        baseCurrency,
        description: `Realized FX on allocating ${existing.documentNumber}`,
        sourceType: 'AR_PAYMENT_ALLOCATION',
        sourceId: existing.id,
        eventId: inserted[0]!.id,
        actor,
        permission: P['customer-payment.post'],
        branchId: existing.branchId,
      });
      const newAllocated = Money.of(existing.allocatedAmount, currency).add(applied);
      await tx
        .update(customerPayments)
        .set({ allocatedAmount: newAllocated.toString() })
        .where(eq(customerPayments.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CustomerPayment',
          entityId: id,
          newValue: { applied: applied.toString(), allocations: input.allocations },
          metadata: { documentNumber: existing.documentNumber, kind: 'allocation' },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'payment.allocated',
        companyId,
        payload: {
          paymentId: id,
          documentNumber: existing.documentNumber,
          customerId: existing.customerId,
          applied: applied.toString(),
          allocated: newAllocated.toString(),
          unallocated: Money.of(existing.amount, currency).subtract(newAllocated).toString(),
          allocations: input.allocations,
        },
      });
      await this.emitPaidInvoices(tx, companyId, targets, currency);
    });
    return this.get(companyId, id);
  }

  /** DRAFT -> SUBMITTED: opens the approval workflow when one matches (Prompt #6). */
  async submit(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<CustomerPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      await this.approvals.open(tx, this.workflowRef(companyId, existing, actor.id));
      await tx
        .update(customerPayments)
        .set({ status: 'SUBMITTED', submittedBy: actor.id, submittedAt: new Date() })
        .where(eq(customerPayments.id, id));
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'CustomerPayment',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'SUBMITTED' },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      await this.notifyOrg(tx, companyId, {
        eventType: 'APPROVAL_REQUIRED',
        title: `Receipt ${existing.documentNumber} awaits approval`,
        body: `${existing.currency} ${existing.amount} submitted for approval.`,
        link: `/receivables/payments/${id}`,
        entityId: id,
        permission: P['customer-payment.approve'],
      });
    });
    return this.get(companyId, id);
  }

  /**
   * DRAFT / SUBMITTED -> APPROVED. Delegated authority, the approval workflow
   * and the self-approval rule are enforced here; posting stays a separate step.
   */
  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<CustomerPaymentDetail> {
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
      const authority = await this.authority.assert(tx, actor, P['customer-payment.approve'], {
        companyId,
        branchId: existing.branchId,
        amount: existing.amount,
        currency: existing.currency,
        documentType: 'CUSTOMER_PAYMENT',
        documentId: id,
        documentNumber: existing.documentNumber,
        createdBy: existing.createdBy,
        action: 'Approved customer payment',
      });
      await tx
        .update(customerPayments)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(customerPayments.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'CustomerPayment',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: existing.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'payment.approved',
        companyId,
        dedupeKey: 'payment.approved:' + id,
        payload: {
          paymentId: id,
          documentNumber: existing.documentNumber,
          customerId: existing.customerId,
          amount: existing.amount,
          currency: existing.currency,
          status: 'APPROVED',
        },
      });
    });
    return this.get(companyId, id);
  }

  private workflowRef(companyId: string, doc: CustomerPayment, requestedBy: string) {
    return {
      companyId,
      documentType: 'CUSTOMER_PAYMENT' as const,
      documentId: doc.id,
      documentNumber: doc.documentNumber,
      amount: doc.amount,
      currency: doc.currency,
      requestedBy,
    };
  }

  /** invoice.paid for every target settled in full by this allocation set. */
  private async emitPaidInvoices(
    tx: DbExecutor,
    companyId: string,
    targets: Map<
      string,
      {
        id: string;
        documentNumber: string;
        status: string;
        total: string;
        currency: string;
        partyId: string;
      }
    >,
    currency: string,
  ): Promise<void> {
    for (const t of targets.values()) {
      if (t.status !== 'PAID') continue;
      await this.outbox.enqueue(tx, {
        eventType: 'invoice.paid',
        companyId,
        dedupeKey: 'invoice.paid:' + t.id,
        payload: {
          invoiceId: t.id,
          documentNumber: t.documentNumber,
          customerId: t.partyId,
          total: t.total,
          currency,
        },
      });
    }
  }

  private async notifyOrg(
    tx: DbExecutor,
    companyId: string,
    input: {
      eventType: 'PAYMENT_RECEIVED' | 'APPROVAL_REQUIRED';
      title: string;
      body: string;
      link: string;
      entityId: string;
      userIds?: string[];
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
        entityType: 'CustomerPayment',
        entityId: input.entityId,
        userIds: input.userIds,
        permission: input.permission,
        companyId,
        dedupeKey: `${input.eventType}:${input.entityId}`,
      },
      tx,
    );
  }

  /** Reverses the ledger entry and releases every allocation. */
  async void(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VoidDocumentInput,
  ): Promise<CustomerPaymentDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      await this.approvals.cancelFor(tx, 'CUSTOMER_PAYMENT', id);
      if (existing.status !== 'POSTED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is not posted.`,
        );
      const allocations = await tx
        .select()
        .from(paymentAllocations)
        .where(eq(paymentAllocations.paymentId, id));
      await this.invoicesService.releaseFromTargets(tx, companyId, allocations, existing.currency);
      await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, id));
      await this.fx.reverseRealized(
        tx,
        companyId,
        'AR_PAYMENT_ALLOCATION',
        existing.id,
        input.reversalDate ?? existing.paymentDate,
        actor,
        P['customer-payment.post'],
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
          sourceType: 'AR_PAYMENT_VOID',
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
        { permission: P['customer-payment.post'] },
      );
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, existing.journalEntryId!));
      await tx
        .update(customerPayments)
        .set({
          status: 'VOID',
          allocatedAmount: '0',
          reversalJournalEntryId: reversal.id,
          voidReason: input.reason,
          voidedBy: actor.id,
          voidedAt: new Date(),
        })
        .where(eq(customerPayments.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'CustomerPayment',
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
        eventType: 'payment.failed',
        companyId,
        dedupeKey: 'payment.failed:' + id,
        payload: {
          paymentId: id,
          documentNumber: existing.documentNumber,
          customerId: existing.customerId,
          amount: existing.amount,
          currency: existing.currency,
          status: 'VOID',
          reason: input.reason,
        },
      });
    });
    return this.get(companyId, id);
  }

  // --------------------------------------------------------------- internals

  private viewQuery() {
    const cash = sql<string>`(select code from accounts a where a.id = ${customerPayments.cashAccountId})`;
    const cashName = sql<string>`(select name from accounts a where a.id = ${customerPayments.cashAccountId})`;
    return this.db
      .select({
        ...getTableColumns(customerPayments),
        customerCode: customers.code,
        customerName: customers.name,
        cashAccountCode: cash,
        cashAccountName: cashName,
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${customerPayments.journalEntryId})`,
      })
      .from(customerPayments)
      .innerJoin(customers, eq(customers.id, customerPayments.customerId));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<CustomerPayment> {
    const [row] = await tx
      .select()
      .from(customerPayments)
      .where(and(eq(customerPayments.id, id), eq(customerPayments.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Customer payment', id);
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

function decorate<T extends CustomerPayment>(
  row: T,
): T & { unallocatedAmount: string; allocationStatus: CustomerPaymentView['allocationStatus'] } {
  const unallocated =
    row.status === 'POSTED'
      ? Money.of(row.amount, row.currency).subtract(Money.of(row.allocatedAmount, row.currency))
      : Money.zero(row.currency);
  const allocationStatus: CustomerPaymentView['allocationStatus'] =
    row.status !== 'POSTED' || row.paymentType !== 'PAYMENT'
      ? null
      : Money.of(row.allocatedAmount, row.currency).isZero()
        ? 'UNALLOCATED'
        : unallocated.isZero()
          ? 'ALLOCATED'
          : 'PARTIALLY_ALLOCATED';
  return { ...row, unallocatedAmount: unallocated.toString(), allocationStatus };
}
