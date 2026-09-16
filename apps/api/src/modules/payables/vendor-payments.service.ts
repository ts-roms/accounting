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
  vendorPayments,
  vendors,
  vendorBills,
  journalEntries,
  journalLines,
  vendorPaymentAllocations,
  type VendorPayment,
} from '@/database/schema';
import { validateAllocations } from '@/modules/subledger/subledger.logic';
import { VendorsService } from './vendors.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { FxService } from '@/modules/fx/fx.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
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
  ) {}

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
    const id = await this.db.transaction(async (tx) => {
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
      const vendor = await this.vendorsService.getOrThrow(companyId, input.partyId, tx);
      if (vendor.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.PARTY_INACTIVE,
          `Vendor ${vendor.code} is inactive.`,
        );
      const currency = vendor.currency;
      const { rate: exchangeRate, baseCurrency } = await this.rates.documentRate(
        companyId,
        currency,
        input.paymentDate,
        input.exchangeRate,
        tx,
      );
      await this.assertCashAccount(companyId, input.cashAccountId, tx);
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
          },
          companyId,
        },
        tx,
      );
      return created.id;
    });
    return this.get(companyId, id);
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
      if (input.cashAccountId) await this.assertCashAccount(companyId, input.cashAccountId, tx);
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
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'POSTED') return;
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      await this.approvals.assertApproved(tx, {
        companyId,
        documentType: 'VENDOR_PAYMENT',
        documentId: id,
        documentNumber: existing.documentNumber,
        amount: existing.amount,
        currency: existing.currency,
        requestedBy: existing.createdBy ?? actor.id,
        branchId: existing.branchId,
      });
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
      const targets = await this.billsService.lockTargets(
        tx,
        companyId,
        draftAllocations.map((a) => a.billId),
      );
      const allocated = validateAllocations(
        draftAllocations.map((a) => ({ documentId: a.billId, amount: a.amount })),
        targets,
        existing.vendorId,
        amount,
        currency,
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
      // AP: bank pays baseAmount; the payable relieved is baseAmount + gain.
      const controlBase = baseAmount.add(gain);
      const fxLines = await this.fx.realizedLines(tx, companyId, gain);
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
            },
            ...fxLines,
          ],
        },
        { permission: P['vendor-payment.post'] },
      );

      await this.billsService.applyToTargets(
        tx,
        targets,
        draftAllocations.map((a) => ({ documentId: a.billId, amount: a.amount })),
        currency,
      );
      await tx
        .update(vendorPaymentAllocations)
        .set({ allocationDate: existing.paymentDate })
        .where(eq(vendorPaymentAllocations.paymentId, id));
      await tx
        .update(vendorPayments)
        .set({
          status: 'POSTED',
          allocatedAmount: allocated.toString(),
          baseAmount: baseAmount.toString(),
          controlBaseAmount: controlBase.toString(),
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
          newValue: { status: 'POSTED', journalEntryId: entry.id, allocated: allocated.toString() },
          metadata: {
            documentNumber: existing.documentNumber,
            journalNumber: entry.documentNumber,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Applies the unallocated part of a posted receipt to open bills (no new ledger entry). */
  async allocate(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: AllocateInput,
    allocationDate = new Date().toISOString().slice(0, 10),
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
      await this.billsService.releaseFromTargets(tx, companyId, allocations, existing.currency);
      await tx.delete(vendorPaymentAllocations).where(eq(vendorPaymentAllocations.paymentId, id));
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
    tx: DbExecutor,
  ): Promise<void> {
    const account = await this.accounts.getOrThrow(companyId, accountId, tx);
    if (account.isHeader || account.status !== 'ACTIVE' || account.type !== 'ASSET') {
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNT_NOT_POSTABLE,
        `${account.code} ${account.name} is not a usable cash or bank account.`,
      );
    }
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
