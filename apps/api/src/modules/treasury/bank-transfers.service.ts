import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CreateBankTransferInput,
  ListBankTransfersQuery,
  SettleBankTransferInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { bankAccounts, bankTransfers, companies, type BankTransfer } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { FxService } from '@/modules/fx/fx.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { SodService } from '@/modules/rbac/sod.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { TreasuryConfigService } from './treasury-config.service';

const MODULE = 'TREASURY';

export interface BankTransferView extends BankTransfer {
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  outJournalNumber: string | null;
  inJournalNumber: string | null;
}

/**
 * Inter-account bank transfers (Prompt #8) settled in two legs so a
 * transfer in flight is never counted twice:
 *
 *   SENT     Dr Cash in transit (base)      / Cr Source bank      (+ Dr bank charges / Cr source for fees)
 *   SETTLED  Dr Destination bank (base)     / Cr Cash in transit  (+ realized FX gain / loss on the difference)
 *
 * Approval is delegable (`bank-transfer.approve`), SoD-checked against the
 * creator and gated by the transfer approval threshold / workflow.
 */
@Injectable()
export class BankTransfersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly rates: ExchangeRatesService,
    private readonly fx: FxService,
    private readonly authority: AuthorityService,
    private readonly approvals: ApprovalsService,
    private readonly sod: SodService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: TreasuryConfigService,
  ) {}

  async list(
    companyId: string,
    query: ListBankTransfersQuery,
  ): Promise<PaginatedResult<BankTransferView>> {
    const filters: SQL[] = [eq(bankTransfers.companyId, companyId)];
    if (query.status) filters.push(eq(bankTransfers.status, query.status));
    if (query.bankAccountId)
      filters.push(
        or(
          eq(bankTransfers.fromBankAccountId, query.bankAccountId),
          eq(bankTransfers.toBankAccountId, query.bankAccountId),
        )!,
      );
    if (query.from) filters.push(gte(bankTransfers.transferDate, query.from));
    if (query.to) filters.push(lte(bankTransfers.transferDate, query.to));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(bankTransfers.transferDate), desc(bankTransfers.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, bankTransfers, where),
    ]);
    return toPaginatedResult(rows.map(decorate), total, query);
  }

  async get(companyId: string, id: string): Promise<BankTransferView> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(bankTransfers.id, id), eq(bankTransfers.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Bank transfer', id);
    return decorate(row);
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBankTransferInput,
  ): Promise<BankTransferView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: bankTransfers.id })
          .from(bankTransfers)
          .where(
            and(
              eq(bankTransfers.companyId, companyId),
              eq(bankTransfers.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const from = await this.bankAccount(companyId, input.fromBankAccountId, tx);
      const to = await this.bankAccount(companyId, input.toBankAccountId, tx);
      await this.posting.resolvePeriod(tx, companyId, input.transferDate, { draft: true });
      const amount = Money.parse(input.amount, from.currency);
      const fee = Money.of(input.feeAmount ?? '0', from.currency);
      const { rate, baseCurrency } = await this.rates.documentRate(
        companyId,
        from.currency,
        input.transferDate,
        undefined,
        tx,
      );
      const baseAmount = amount.convert(baseCurrency, rate);
      // Destination amount: given, or the base value re-expressed in the destination currency at its rate.
      let received: Money;
      if (input.receivedAmount) received = Money.parse(input.receivedAmount, to.currency);
      else if (to.currency === from.currency) received = amount;
      else {
        const toRate = await this.rates.documentRate(
          companyId,
          to.currency,
          input.transferDate,
          undefined,
          tx,
        );
        received = baseAmount.convert(to.currency, (1 / Number(toRate.rate)).toString());
      }
      const documentNumber = await this.numbering.allocate(
        companyId,
        'BTR',
        Number(input.transferDate.slice(0, 4)),
        tx,
      );
      const [row] = await tx
        .insert(bankTransfers)
        .values({
          companyId,
          documentNumber,
          purpose: input.purpose,
          fromBankAccountId: from.id,
          toBankAccountId: to.id,
          transferDate: input.transferDate,
          expectedSettlementDate: input.expectedSettlementDate ?? input.transferDate,
          amount: amount.toString(),
          fromCurrency: from.currency,
          receivedAmount: received.toString(),
          toCurrency: to.currency,
          baseAmount: baseAmount.toString(),
          feeAmount: fee.toString(),
          exchangeRate: rate,
          reference: input.reference ?? null,
          memo: input.memo ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'BankTransfer',
          entityId: row!.id,
          newValue: {
            documentNumber,
            from: from.code,
            to: to.code,
            amount: amount.toString(),
            receivedAmount: received.toString(),
          },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!.id;
    });
    return this.get(companyId, id);
  }

  /** Delegable approval; the creator may not approve; above the threshold a workflow may be required. */
  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<BankTransferView> {
    await this.db.transaction(async (tx) => {
      const t = await this.lock(tx, companyId, id);
      this.assertStatus(t, ['DRAFT'], 'approved');
      await this.approvals.assertApproved(
        tx,
        this.workflowRef(companyId, t, t.createdBy ?? actor.id),
      );
      const authority = await this.authority.assert(tx, actor, P['bank-transfer.approve'], {
        companyId,
        branchId: null,
        amount: t.baseAmount,
        currency: t.fromCurrency,
        documentType: 'BANK_TRANSFER',
        documentId: id,
        documentNumber: t.documentNumber,
        createdBy: t.createdBy,
        action: 'Approved bank transfer',
      });
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['bank-transfer.create'], P['bank-transfer.approve']],
        t.createdBy,
        actor.id,
        tx,
        {
          companyId,
          entityType: 'BankTransfer',
          entityId: id,
          documentNumber: t.documentNumber,
        },
      );
      await tx
        .update(bankTransfers)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(bankTransfers.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'BankTransfer',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: t.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bank_transfer.approved',
        companyId,
        dedupeKey: 'bank_transfer.approved:' + id,
        payload: this.eventPayload(t, 'APPROVED'),
      });
    });
    return this.get(companyId, id);
  }

  /** Submit for approval: opens the workflow (when configured) and tells approvers. */
  async submit(companyId: string, actor: AuthenticatedUser, id: string): Promise<BankTransferView> {
    await this.db.transaction(async (tx) => {
      const t = await this.lock(tx, companyId, id);
      this.assertStatus(t, ['DRAFT'], 'submitted');
      await this.approvals.open(tx, this.workflowRef(companyId, t, actor.id));
      const [company] = await tx
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId));
      await this.notifications.notify(
        {
          organizationId: company!.organizationId,
          eventType: 'BANK_TRANSFER_APPROVAL_REQUIRED',
          severity: 'INFO',
          title: `Bank transfer ${t.documentNumber} awaits approval`,
          body: `${t.fromCurrency} ${t.amount} on ${t.transferDate}, submitted by ${actor.email}.`,
          link: `/treasury/transfers`,
          entityType: 'BankTransfer',
          entityId: id,
          permission: 'bank-transfer.approve',
          companyId,
          dedupeKey: `transfer-approval:${id}`,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'BankTransfer',
          entityId: id,
          metadata: { documentNumber: t.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Out leg: Dr cash in transit / Cr source bank (+ fee to bank charges). */
  async send(companyId: string, actor: AuthenticatedUser, id: string): Promise<BankTransferView> {
    await this.db.transaction(async (tx) => {
      const t = await this.lock(tx, companyId, id);
      const settings = await this.config.settings(companyId, tx);
      const needsApproval =
        settings.transferApprovalThreshold === null ||
        Money.of(t.baseAmount, await this.accounts.companyCurrency(companyId, tx)).greaterThan(
          Money.of(
            settings.transferApprovalThreshold,
            await this.accounts.companyCurrency(companyId, tx),
          ),
        );
      if (needsApproval) this.assertStatus(t, ['APPROVED'], 'sent');
      else this.assertStatus(t, ['DRAFT', 'APPROVED'], 'sent');
      const from = await this.bankAccount(companyId, t.fromBankAccountId, tx);
      const transit = await this.accounts.resolveMapped(companyId, 'CASH_IN_TRANSIT', tx);
      const base = await this.accounts.companyCurrency(companyId, tx);
      const baseAmount = Money.of(t.baseAmount, base);
      const feeBase = Money.of(t.feeAmount, t.fromCurrency).convert(base, t.exchangeRate);
      const lines = [
        {
          accountId: transit.id,
          debit: baseAmount.toString(),
          credit: '0',
          description: `${t.documentNumber} cash in transit`,
        },
        {
          accountId: from.glAccountId,
          debit: '0',
          credit: baseAmount.add(feeBase).toString(),
          description: `${t.documentNumber} transfer out`,
        },
      ];
      if (feeBase.isPositive()) {
        const charges = await this.accounts.resolveMapped(companyId, 'BANK_CHARGES', tx);
        lines.push({
          accountId: charges.id,
          debit: feeBase.toString(),
          credit: '0',
          description: `${t.documentNumber} transfer fee`,
        });
      }
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: t.transferDate,
          description: `Bank transfer ${t.documentNumber}${t.memo ? ` - ${t.memo}` : ''}`,
          reference: t.reference ?? t.documentNumber,
          sourceType: 'BANK_TRANSFER_OUT',
          sourceId: t.id,
          actor,
          lines,
        },
        { permission: P['bank-transfer.post'] },
      );
      await tx
        .update(bankTransfers)
        .set({ status: 'SENT', outJournalEntryId: entry.id, sentBy: actor.id, sentAt: new Date() })
        .where(eq(bankTransfers.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'BankTransfer',
          entityId: id,
          previousValue: { status: t.status },
          newValue: { status: 'SENT', outJournalEntryId: entry.id },
          metadata: { documentNumber: t.documentNumber, journalNumber: entry.documentNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bank_transfer.sent',
        companyId,
        dedupeKey: 'bank_transfer.sent:' + id,
        payload: { ...this.eventPayload(t, 'SENT'), journalNumber: entry.documentNumber },
      });
    });
    return this.get(companyId, id);
  }

  /** In leg: Dr destination bank / Cr cash in transit; any base difference is realized FX. */
  async settle(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: SettleBankTransferInput,
  ): Promise<BankTransferView> {
    await this.db.transaction(async (tx) => {
      const t = await this.lock(tx, companyId, id);
      this.assertStatus(t, ['SENT'], 'settled');
      const to = await this.bankAccount(companyId, t.toBankAccountId, tx);
      const transit = await this.accounts.resolveMapped(companyId, 'CASH_IN_TRANSIT', tx);
      const base = await this.accounts.companyCurrency(companyId, tx);
      const settlementDate = input.settlementDate ?? new Date().toISOString().slice(0, 10);
      if (settlementDate < t.transferDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Settlement cannot precede the transfer date.',
        );
      const received = input.receivedAmount
        ? Money.parse(input.receivedAmount, t.toCurrency)
        : Money.of(t.receivedAmount, t.toCurrency);
      const { rate } = await this.rates.documentRate(
        companyId,
        t.toCurrency,
        settlementDate,
        undefined,
        tx,
      );
      const receivedBase = received.convert(base, rate);
      const transitBase = Money.of(t.baseAmount, base);
      // Gain when the destination is worth more in base than what left the source.
      const gain = receivedBase.subtract(transitBase);
      const fxLines = await this.fx.realizedLines(tx, companyId, gain);
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: settlementDate,
          description: `Bank transfer ${t.documentNumber} settled`,
          reference: input.bankReference ?? t.reference ?? t.documentNumber,
          sourceType: 'BANK_TRANSFER_IN',
          sourceId: t.id,
          actor,
          lines: [
            {
              accountId: to.glAccountId,
              debit: receivedBase.toString(),
              credit: '0',
              description: `${t.documentNumber} transfer in`,
            },
            {
              accountId: transit.id,
              debit: '0',
              credit: transitBase.toString(),
              description: `${t.documentNumber} out of transit`,
            },
            ...fxLines,
          ],
        },
        { permission: P['bank-transfer.post'] },
      );
      await tx
        .update(bankTransfers)
        .set({
          status: 'SETTLED',
          settlementDate,
          receivedAmount: received.toString(),
          fxDifference: gain.toString(),
          bankReference: input.bankReference ?? t.bankReference,
          inJournalEntryId: entry.id,
          settledBy: actor.id,
          settledAt: new Date(),
        })
        .where(eq(bankTransfers.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'BankTransfer',
          entityId: id,
          previousValue: { status: 'SENT' },
          newValue: {
            status: 'SETTLED',
            inJournalEntryId: entry.id,
            fxDifference: gain.toString(),
          },
          metadata: { documentNumber: t.documentNumber, journalNumber: entry.documentNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'bank_transfer.settled',
        companyId,
        dedupeKey: 'bank_transfer.settled:' + id,
        payload: {
          ...this.eventPayload(t, 'SETTLED'),
          fxDifference: gain.toString(),
          journalNumber: entry.documentNumber,
        },
      });
    });
    return this.get(companyId, id);
  }

  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<BankTransferView> {
    await this.db.transaction(async (tx) => {
      const t = await this.lock(tx, companyId, id);
      this.assertStatus(t, ['DRAFT', 'APPROVED'], 'cancelled');
      await this.approvals.cancelFor(tx, 'BANK_TRANSFER', id);
      await tx
        .update(bankTransfers)
        .set({ status: 'CANCELLED', cancelReason: reason })
        .where(eq(bankTransfers.id, id));
      await this.audit.record(
        {
          action: 'CANCEL',
          module: MODULE,
          entityType: 'BankTransfer',
          entityId: id,
          previousValue: { status: t.status },
          newValue: { status: 'CANCELLED' },
          metadata: { documentNumber: t.documentNumber, reason, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Sent transfers past their expected settlement by more than the warning window. */
  async unsettled(companyId: string, asOf: string, warnDays: number): Promise<BankTransferView[]> {
    const rows = await this.viewQuery(this.db).where(
      and(eq(bankTransfers.companyId, companyId), eq(bankTransfers.status, 'SENT')),
    );
    const cutoff = new Date(asOf);
    return rows
      .map(decorate)
      .filter(
        (t) =>
          (cutoff.getTime() - new Date(t.expectedSettlementDate).getTime()) / 86_400_000 > warnDays,
      );
  }

  // ---------------------------------------------------------------- internals

  private async bankAccount(companyId: string, id: string, tx: DbExecutor) {
    const [row] = await tx
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)));
    if (!row) throw new NotFoundError('Bank account', id);
    if (row.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `Bank account ${row.code} is inactive.`,
      );
    return row;
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<BankTransfer> {
    const [row] = await tx
      .select()
      .from(bankTransfers)
      .where(and(eq(bankTransfers.id, id), eq(bankTransfers.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Bank transfer', id);
    return row;
  }

  private assertStatus(t: BankTransfer, allowed: BankTransfer['status'][], verb: string): void {
    if (!allowed.includes(t.status))
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${t.documentNumber} cannot be ${verb} from status ${t.status}.`,
        { status: t.status, allowed },
      );
  }

  private workflowRef(companyId: string, t: BankTransfer, requestedBy: string) {
    return {
      companyId,
      documentType: 'BANK_TRANSFER' as const,
      documentId: t.id,
      documentNumber: t.documentNumber,
      amount: t.baseAmount,
      currency: t.fromCurrency,
      requestedBy,
    };
  }

  private eventPayload(t: BankTransfer, status: string) {
    return {
      transferId: t.id,
      documentNumber: t.documentNumber,
      fromBankAccountId: t.fromBankAccountId,
      toBankAccountId: t.toBankAccountId,
      amount: t.amount,
      currency: t.fromCurrency,
      receivedAmount: t.receivedAmount,
      toCurrency: t.toCurrency,
      transferDate: t.transferDate,
      expectedSettlementDate: t.expectedSettlementDate,
      status,
    };
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        transfer: bankTransfers,
        fromCode: bankAccounts.code,
        fromName: bankAccounts.name,
        toCode: toAccount.code,
        toName: toAccount.name,
        outJournalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${bankTransfers.outJournalEntryId})`,
        inJournalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${bankTransfers.inJournalEntryId})`,
      })
      .from(bankTransfers)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransfers.fromBankAccountId))
      .innerJoin(toAccount, eq(toAccount.id, bankTransfers.toBankAccountId));
  }
}

const toAccount = alias(bankAccounts, 'to_account');

function decorate(row: {
  transfer: BankTransfer;
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  outJournalNumber: string | null;
  inJournalNumber: string | null;
}): BankTransferView {
  return {
    ...row.transfer,
    fromCode: row.fromCode,
    fromName: row.fromName,
    toCode: row.toCode,
    toName: row.toName,
    outJournalNumber: row.outJournalNumber,
    inJournalNumber: row.inJournalNumber,
  };
}
