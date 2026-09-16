import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type AccountMappingKey, type PaginatedResult } from '@accounting/types';
import type {
  CreateProvisionRunInput,
  CreateWriteOffInput,
  ListWriteOffsQuery,
  RecoverWriteOffInput,
  WriteOffDecisionInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  badDebtProvisions,
  companies,
  customers,
  invoices,
  journalEntries,
  paymentAllocations,
  writeOffRequests,
  type BadDebtProvision,
  type WriteOffRequest,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import {
  GeneralLedgerService,
  signedBalance,
} from '@/modules/accounting/ledger/general-ledger.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { deriveDocumentStatus } from '@/modules/subledger/subledger.logic';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { ArConfigService } from './ar-config.service';
import { ArReportsService } from './ar-reports.service';
import { DisputesService } from './disputes.service';
import { InvoicesService } from './invoices.service';
import { agingProvision } from './receivables.logic';

const MODULE = 'RECEIVABLES';

export interface WriteOffView extends WriteOffRequest {
  customerCode: string;
  customerName: string;
  invoiceNumber: string;
  invoiceBalance: string;
  journalNumber: string | null;
  recoveryJournalNumber: string | null;
  debitAccountCode: string | null;
  requestedByName: string | null;
}

export interface ProvisionView extends BadDebtProvision {
  journalNumber: string | null;
}

/**
 * Write-offs and bad debt (Prompt #6). A receivable balance only leaves the
 * subledger through an approved write-off request that posts through the
 * posting gateway (Dr allowance / bad-debt expense / write-off account,
 * Cr AR control) and settles the invoice with a write-off allocation - so the
 * aging, statement and AR/GL reconciliation stay in agreement. Recovery
 * reverses the write-off and reinstates the balance for normal collection.
 * Provisioning brings the allowance account to the required level from
 * configurable aging rates or specific invoices.
 */
@Injectable()
export class WriteOffsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly ledger: GeneralLedgerService,
    private readonly approvals: ApprovalsService,
    private readonly authority: AuthorityService,
    private readonly invoicesService: InvoicesService,
    private readonly disputes: DisputesService,
    private readonly config: ArConfigService,
    private readonly reports: ArReportsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------- write-offs

  async list(companyId: string, query: ListWriteOffsQuery): Promise<PaginatedResult<WriteOffView>> {
    const filters: SQL[] = [eq(writeOffRequests.companyId, companyId)];
    if (query.customerId) filters.push(eq(writeOffRequests.customerId, query.customerId));
    if (query.status) filters.push(eq(writeOffRequests.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(writeOffRequests.documentNumber, term),
          ilike(invoices.documentNumber, term),
          ilike(customers.name, term),
        )!,
      );
    }
    const where = and(...filters);
    const [rows, count] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(
          query.sortDir === 'asc'
            ? asc(writeOffRequests.createdAt)
            : desc(writeOffRequests.createdAt),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(writeOffRequests)
        .innerJoin(invoices, eq(invoices.id, writeOffRequests.invoiceId))
        .innerJoin(customers, eq(customers.id, writeOffRequests.customerId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(count[0]?.n ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<WriteOffView> {
    const [row] = await this.viewQuery().where(
      and(eq(writeOffRequests.id, id), eq(writeOffRequests.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Write-off', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateWriteOffInput,
  ): Promise<WriteOffView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: writeOffRequests.id })
          .from(writeOffRequests)
          .where(
            and(
              eq(writeOffRequests.companyId, companyId),
              eq(writeOffRequests.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const invoice = await this.lockInvoice(tx, companyId, input.invoiceId);
      const balance = Money.of(invoice.total, invoice.currency).subtract(
        Money.of(invoice.allocatedAmount, invoice.currency),
      );
      if (!balance.isPositive())
        throw new BusinessRuleError(
          ErrorCodes.WRITE_OFF_INVALID,
          `${invoice.documentNumber} has no open balance to write off.`,
        );
      const amount = input.amount ? Money.parse(input.amount, invoice.currency) : balance;
      if (amount.greaterThan(balance))
        throw new BusinessRuleError(
          ErrorCodes.WRITE_OFF_INVALID,
          `Write-off ${amount.toString()} exceeds the open balance ${balance.toString()}.`,
          { balance: balance.toString() },
        );
      // Other pending requests on the same invoice count against the balance too.
      const [pending] = await tx
        .select({ total: sql<string>`coalesce(sum(${writeOffRequests.amount}), 0)` })
        .from(writeOffRequests)
        .where(
          and(
            eq(writeOffRequests.invoiceId, invoice.id),
            inArray(writeOffRequests.status, ['DRAFT', 'SUBMITTED', 'APPROVED']),
          ),
        );
      if (
        Money.of(pending?.total ?? '0', invoice.currency)
          .add(amount)
          .greaterThan(balance)
      )
        throw new BusinessRuleError(
          ErrorCodes.WRITE_OFF_INVALID,
          `${invoice.documentNumber} already has pending write-off requests covering its balance.`,
        );
      const settings = await this.config.settings(companyId, tx);
      if (
        input.reason === 'SMALL_BALANCE' &&
        amount.greaterThan(Money.of(settings.smallBalanceThreshold, invoice.currency))
      )
        throw new BusinessRuleError(
          ErrorCodes.WRITE_OFF_INVALID,
          `Small-balance write-offs are limited to ${settings.smallBalanceThreshold}; use another reason.`,
        );
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const documentNumber = await this.numbering.allocate(
        companyId,
        'WO',
        new Date().getFullYear(),
        tx,
      );
      const [created] = await tx
        .insert(writeOffRequests)
        .values({
          companyId,
          branchId: invoice.branchId,
          documentNumber,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          reason: input.reason,
          justification: input.justification,
          currency: invoice.currency,
          amount: amount.toString(),
          exchangeRate: invoice.exchangeRate,
          baseAmount: amount.convert(baseCurrency, invoice.exchangeRate).toString(),
          writeOffDate: input.writeOffDate ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          requestedBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'WriteOffRequest',
          entityId: created!.id,
          newValue: {
            documentNumber,
            invoice: invoice.documentNumber,
            amount: amount.toString(),
            reason: input.reason,
          },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async submit(companyId: string, actor: AuthenticatedUser, id: string): Promise<WriteOffView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT'], 'submitted');
      await this.approvals.open(tx, this.workflowRef(companyId, existing, actor.id));
      await tx
        .update(writeOffRequests)
        .set({ status: 'SUBMITTED', submittedAt: new Date() })
        .where(eq(writeOffRequests.id, id));
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'WriteOffRequest',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'SUBMITTED' },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      const [company] = await tx
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (company)
        await this.notifications.notify(
          {
            organizationId: company.organizationId,
            eventType: 'WRITE_OFF_APPROVAL_REQUIRED',
            title: `Write-off ${existing.documentNumber} awaits approval`,
            body: `${existing.currency} ${existing.amount} (${existing.reason.toLowerCase().replace(/_/g, ' ')}): ${existing.justification.slice(0, 200)}`,
            link: `/receivables/write-offs/${id}`,
            entityType: 'WriteOffRequest',
            entityId: id,
            permission: P['write-off.approve'],
            companyId,
            dedupeKey: `write-off-approval:${id}`,
          },
          tx,
        );
    });
    return this.get(companyId, id);
  }

  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: WriteOffDecisionInput,
  ): Promise<WriteOffView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'SUBMITTED'], 'approved');
      if (existing.requestedBy === actor.id)
        throw new BusinessRuleError(
          ErrorCodes.SOD_VIOLATION,
          'A write-off cannot be approved by the person who requested it.',
        );
      await this.approvals.assertApproved(
        tx,
        this.workflowRef(companyId, existing, existing.requestedBy ?? actor.id),
      );
      const authority = await this.authority.assert(tx, actor, P['write-off.approve'], {
        companyId,
        branchId: existing.branchId,
        amount: existing.amount,
        currency: existing.currency,
        documentType: 'WRITE_OFF',
        documentId: id,
        documentNumber: existing.documentNumber,
        createdBy: existing.requestedBy,
        action: 'Approved receivable write-off',
      });
      await tx
        .update(writeOffRequests)
        .set({
          status: 'APPROVED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          decisionComment: input.comment ?? null,
        })
        .where(eq(writeOffRequests.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'WriteOffRequest',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'APPROVED', comment: input.comment },
          metadata: {
            documentNumber: existing.documentNumber,
            kind: 'WRITE_OFF_APPROVED',
            ...authority.audit,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async reject(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: WriteOffDecisionInput,
  ): Promise<WriteOffView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'SUBMITTED', 'APPROVED'], 'rejected');
      await this.approvals.cancelFor(tx, 'WRITE_OFF', id);
      await tx
        .update(writeOffRequests)
        .set({
          status: existing.status === 'DRAFT' ? 'CANCELLED' : 'REJECTED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          decisionComment: input.comment ?? null,
        })
        .where(eq(writeOffRequests.id, id));
      await this.audit.record(
        {
          action: 'REJECT',
          module: MODULE,
          entityType: 'WriteOffRequest',
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

  /** APPROVED -> POSTED: journal through the gateway + write-off allocation on the invoice. Idempotent. */
  async post(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    writeOffDate?: string,
  ): Promise<WriteOffView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'POSTED') return;
      this.assertStatus(existing, ['APPROVED'], 'posted');
      const invoice = await this.lockInvoice(tx, companyId, existing.invoiceId);
      if (await this.disputes.openDisputeCount(tx, invoice.id))
        throw new BusinessRuleError(
          ErrorCodes.INVOICE_DISPUTED,
          `${invoice.documentNumber} has an open dispute; resolve it before writing the balance off.`,
        );
      const amount = Money.of(existing.amount, existing.currency);
      const balance = Money.of(invoice.total, invoice.currency).subtract(
        Money.of(invoice.allocatedAmount, invoice.currency),
      );
      if (amount.greaterThan(balance))
        throw new BusinessRuleError(
          ErrorCodes.WRITE_OFF_INVALID,
          `Only ${balance.toString()} remains open on ${invoice.documentNumber}.`,
        );
      const date = writeOffDate ?? existing.writeOffDate ?? new Date().toISOString().slice(0, 10);
      const settings = await this.config.settings(companyId, tx);
      const debitKey: AccountMappingKey =
        existing.reason === 'BAD_DEBT' || existing.reason === 'UNCOLLECTIBLE'
          ? settings.useAllowanceForBadDebt
            ? 'ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS'
            : 'BAD_DEBT_EXPENSE'
          : 'AR_WRITE_OFF';
      const debit = await this.accounts.resolveMapped(companyId, debitKey, tx);
      const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_RECEIVABLE', tx);
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const baseAmount = amount.convert(baseCurrency, invoice.exchangeRate);
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: date,
          description: `Write-off ${existing.documentNumber} - ${invoice.documentNumber} (${existing.reason.toLowerCase().replace(/_/g, ' ')})`,
          reference: invoice.documentNumber,
          journalType: 'GENERAL',
          branchId: existing.branchId,
          sourceType: 'AR_WRITE_OFF',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: debit.id,
              debit: baseAmount.toString(),
              credit: '0',
              description: `${invoice.documentNumber} written off: ${existing.justification.slice(0, 120)}`,
            },
            {
              accountId: control.id,
              debit: '0',
              credit: baseAmount.toString(),
              description: `${invoice.documentNumber} - customer receivable written off`,
            },
          ],
        },
        { permission: P['write-off.post'] },
      );
      await tx.insert(paymentAllocations).values({
        companyId,
        invoiceId: invoice.id,
        writeOffId: existing.id,
        amount: amount.toString(),
        allocationDate: date,
        createdBy: actor.id,
      });
      const allocated = Money.of(invoice.allocatedAmount, invoice.currency).add(amount);
      const settled = deriveDocumentStatus(Money.of(invoice.total, invoice.currency), allocated);
      await tx
        .update(invoices)
        .set({
          allocatedAmount: allocated.toString(),
          writtenOffAmount: Money.of(invoice.writtenOffAmount, invoice.currency)
            .add(amount)
            .toString(),
          status: settled === 'PAID' ? 'WRITTEN_OFF' : settled,
        })
        .where(eq(invoices.id, invoice.id));
      await tx
        .update(writeOffRequests)
        .set({
          status: 'POSTED',
          writeOffDate: date,
          baseAmount: baseAmount.toString(),
          debitAccountId: debit.id,
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(writeOffRequests.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'WriteOffRequest',
          entityId: id,
          newValue: {
            status: 'POSTED',
            journalEntryId: entry.id,
            debitAccount: debit.code,
            amount: amount.toString(),
          },
          metadata: {
            documentNumber: existing.documentNumber,
            journalNumber: entry.documentNumber,
            invoice: invoice.documentNumber,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'write_off.posted',
        companyId,
        dedupeKey: 'write_off.posted:' + id,
        payload: {
          writeOffId: id,
          documentNumber: existing.documentNumber,
          invoiceId: invoice.id,
          invoiceNumber: invoice.documentNumber,
          customerId: invoice.customerId,
          amount: amount.toString(),
          currency: existing.currency,
          reason: existing.reason,
          journalNumber: entry.documentNumber,
        },
      });
    });
    return this.get(companyId, id);
  }

  /** POSTED -> RECOVERED: reverses the write-off journal and reinstates the balance so cash can be applied. */
  async recover(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: RecoverWriteOffInput,
  ): Promise<WriteOffView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['POSTED'], 'recovered');
      const invoice = await this.lockInvoice(tx, companyId, existing.invoiceId);
      const amount = Money.of(existing.amount, existing.currency);
      const settings = await this.config.settings(companyId, tx);
      const control = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_RECEIVABLE', tx);
      // Allowance-based write-offs reinstate the allowance; expense-based ones book a recovery.
      const creditKey: AccountMappingKey =
        (existing.reason === 'BAD_DEBT' || existing.reason === 'UNCOLLECTIBLE') &&
        !settings.useAllowanceForBadDebt
          ? 'BAD_DEBT_RECOVERY'
          : existing.reason === 'BAD_DEBT' || existing.reason === 'UNCOLLECTIBLE'
            ? 'ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS'
            : 'AR_WRITE_OFF';
      const credit = await this.accounts.resolveMapped(companyId, creditKey, tx);
      const baseAmount = Money.of(
        existing.baseAmount,
        await this.accounts.companyCurrency(companyId, tx),
      );
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.recoveryDate,
          description: `Recovery of write-off ${existing.documentNumber} - ${invoice.documentNumber}: ${input.reason}`,
          reference: invoice.documentNumber,
          journalType: 'GENERAL',
          branchId: existing.branchId,
          sourceType: 'AR_WRITE_OFF_RECOVERY',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: control.id,
              debit: baseAmount.toString(),
              credit: '0',
              description: `${invoice.documentNumber} - receivable reinstated`,
            },
            {
              accountId: credit.id,
              debit: '0',
              credit: baseAmount.toString(),
              description: `${invoice.documentNumber} write-off recovered`,
            },
          ],
        },
        { permission: P['write-off.post'] },
      );
      await tx.delete(paymentAllocations).where(eq(paymentAllocations.writeOffId, existing.id));
      const allocated = Money.of(invoice.allocatedAmount, invoice.currency).subtract(amount);
      await tx
        .update(invoices)
        .set({
          allocatedAmount: allocated.toString(),
          writtenOffAmount: Money.of(invoice.writtenOffAmount, invoice.currency)
            .subtract(amount)
            .toString(),
          status: deriveDocumentStatus(Money.of(invoice.total, invoice.currency), allocated),
        })
        .where(eq(invoices.id, invoice.id));
      await tx
        .update(writeOffRequests)
        .set({
          status: 'RECOVERED',
          recoveryJournalEntryId: entry.id,
          recoveryDate: input.recoveryDate,
          recoveryReason: input.reason,
        })
        .where(eq(writeOffRequests.id, id));
      await this.audit.record(
        {
          action: 'REVERSE',
          module: MODULE,
          entityType: 'WriteOffRequest',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: { status: 'RECOVERED', recoveryJournalEntryId: entry.id, reason: input.reason },
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

  // ------------------------------------------------------------ provisions

  async listProvisions(companyId: string): Promise<ProvisionView[]> {
    return this.db
      .select({
        ...this.provisionColumns(),
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${badDebtProvisions.journalEntryId})`,
      })
      .from(badDebtProvisions)
      .where(eq(badDebtProvisions.companyId, companyId))
      .orderBy(desc(badDebtProvisions.asOf), desc(badDebtProvisions.createdAt));
  }

  async getProvision(companyId: string, id: string): Promise<ProvisionView> {
    const [row] = await this.db
      .select({
        ...this.provisionColumns(),
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${badDebtProvisions.journalEntryId})`,
      })
      .from(badDebtProvisions)
      .where(and(eq(badDebtProvisions.id, id), eq(badDebtProvisions.companyId, companyId)));
    if (!row) throw new NotFoundError('Bad-debt provision', id);
    return row;
  }

  /** Computes the required allowance as of a date and drafts the adjustment run. */
  async createProvision(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateProvisionRunInput,
  ): Promise<ProvisionView> {
    const id = await this.db.transaction(async (tx) => {
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const settings = await this.config.settings(companyId, tx);
      let required: Money;
      let computation: Record<string, unknown>;
      if (input.method === 'SPECIFIC') {
        if (!input.specific?.length)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'Specific provisioning needs at least one invoice.',
          );
        const rows = await tx
          .select({
            id: invoices.id,
            documentNumber: invoices.documentNumber,
            total: invoices.total,
            allocatedAmount: invoices.allocatedAmount,
          })
          .from(invoices)
          .where(
            and(
              eq(invoices.companyId, companyId),
              inArray(
                invoices.id,
                input.specific.map((s) => s.invoiceId),
              ),
            ),
          );
        const byId = new Map(rows.map((r) => [r.id, r]));
        required = Money.zero(currency);
        const items = input.specific.map((s) => {
          const inv = byId.get(s.invoiceId);
          if (!inv) throw new NotFoundError('Invoice', s.invoiceId);
          const amount = Money.parse(s.amount, currency);
          const balance = Money.of(inv.total, currency).subtract(
            Money.of(inv.allocatedAmount, currency),
          );
          if (amount.greaterThan(balance))
            throw new BusinessRuleError(
              ErrorCodes.VALIDATION_FAILED,
              `${inv.documentNumber}: allowance ${amount.toString()} exceeds the balance ${balance.toString()}.`,
            );
          required = required.add(amount);
          return {
            invoiceId: inv.id,
            documentNumber: inv.documentNumber,
            balance: balance.toString(),
            allowance: amount.toString(),
          };
        });
        computation = { method: 'SPECIFIC', items };
      } else {
        const rates = input.rates ?? settings.provisionRates;
        if (!Object.keys(rates).length)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'Configure allowance rates per aging bucket in the AR settings first.',
          );
        const aging = await this.reports.aging(companyId, { asOf: input.asOf });
        const buckets = aging.buckets.map((b) => ({
          key: b.key,
          balance: aging.totals[b.key] ?? '0',
        }));
        const result = agingProvision(buckets, rates, currency);
        required = result.required;
        computation = { method: 'AGING_PERCENT', rates, buckets: result.byBucket };
      }
      const allowance = await this.accounts.resolveMapped(
        companyId,
        'ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS',
        tx,
      );
      const activity = await this.ledger.activity({ companyId, to: input.asOf }, tx);
      const row = activity.find((a) => a.accountId === allowance.id);
      // The allowance is a contra-asset (credit-normal): its signed balance is the provision on the books.
      const existing = signedBalance(
        Money.of(row?.debit ?? '0', currency).subtract(Money.of(row?.credit ?? '0', currency)),
        allowance.normalBalance,
      );
      const adjustment = required.subtract(existing);
      const documentNumber = await this.numbering.allocate(
        companyId,
        'PRV',
        Number(input.asOf.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(badDebtProvisions)
        .values({
          companyId,
          documentNumber,
          asOf: input.asOf,
          method: input.method,
          currency,
          computation,
          requiredAllowance: required.toString(),
          existingAllowance: existing.toString(),
          adjustment: adjustment.toString(),
          description: input.description ?? null,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'BadDebtProvision',
          entityId: created!.id,
          newValue: {
            documentNumber,
            asOf: input.asOf,
            required: required.toString(),
            existing: existing.toString(),
            adjustment: adjustment.toString(),
          },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.getProvision(companyId, id);
  }

  /** Posts Dr bad-debt expense / Cr allowance (or the release when the allowance is too high). */
  async postProvision(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<ProvisionView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(badDebtProvisions)
        .where(and(eq(badDebtProvisions.id, id), eq(badDebtProvisions.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Bad-debt provision', id);
      if (existing.status === 'POSTED') return;
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      const adjustment = Money.of(existing.adjustment, existing.currency);
      if (adjustment.isZero())
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The allowance is already at the required level; nothing to post.',
        );
      const expense = await this.accounts.resolveMapped(companyId, 'BAD_DEBT_EXPENSE', tx);
      const allowance = await this.accounts.resolveMapped(
        companyId,
        'ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS',
        tx,
      );
      const abs = adjustment.isNegative() ? adjustment.negate() : adjustment;
      const increase = !adjustment.isNegative();
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: existing.asOf,
          description: `Bad-debt provision ${existing.documentNumber} as of ${existing.asOf}${existing.description ? ` - ${existing.description}` : ''}`,
          reference: existing.documentNumber,
          journalType: 'GENERAL',
          sourceType: 'AR_PROVISION',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: expense.id,
              debit: increase ? abs.toString() : '0',
              credit: increase ? '0' : abs.toString(),
              description: increase ? 'Bad-debt expense' : 'Release of bad-debt allowance',
            },
            {
              accountId: allowance.id,
              debit: increase ? '0' : abs.toString(),
              credit: increase ? abs.toString() : '0',
              description: 'Allowance for doubtful accounts',
            },
          ],
        },
        { permission: P['write-off.post'] },
      );
      await tx
        .update(badDebtProvisions)
        .set({
          status: 'POSTED',
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(badDebtProvisions.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'BadDebtProvision',
          entityId: id,
          newValue: {
            status: 'POSTED',
            journalEntryId: entry.id,
            adjustment: adjustment.toString(),
          },
          metadata: {
            documentNumber: existing.documentNumber,
            journalNumber: entry.documentNumber,
          },
          companyId,
        },
        tx,
      );
    });
    return this.getProvision(companyId, id);
  }

  async reverseProvision(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reversalDate: string,
    reason: string,
  ): Promise<ProvisionView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(badDebtProvisions)
        .where(and(eq(badDebtProvisions.id, id), eq(badDebtProvisions.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Bad-debt provision', id);
      if (existing.status !== 'POSTED' || !existing.journalEntryId)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is not posted.`,
        );
      const originalLines = await tx.query.journalLines.findMany({
        where: (l, ops) => ops.eq(l.journalEntryId, existing.journalEntryId!),
        orderBy: (l, ops) => ops.asc(l.lineNumber),
      });
      const reversal = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: reversalDate,
          description: `Reverse bad-debt provision ${existing.documentNumber}: ${reason}`,
          reference: existing.documentNumber,
          journalType: 'REVERSAL',
          sourceType: 'AR_PROVISION_REVERSAL',
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
        { permission: P['write-off.post'] },
      );
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, existing.journalEntryId));
      await tx
        .update(badDebtProvisions)
        .set({ status: 'REVERSED', reversalJournalEntryId: reversal.id })
        .where(eq(badDebtProvisions.id, id));
      await this.audit.record(
        {
          action: 'REVERSE',
          module: MODULE,
          entityType: 'BadDebtProvision',
          entityId: id,
          newValue: { status: 'REVERSED', reversalJournalEntryId: reversal.id, reason },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.getProvision(companyId, id);
  }

  // --------------------------------------------------------------- internals

  private workflowRef(companyId: string, doc: WriteOffRequest, requestedBy: string) {
    return {
      companyId,
      documentType: 'WRITE_OFF' as const,
      documentId: doc.id,
      documentNumber: doc.documentNumber,
      amount: doc.amount,
      currency: doc.currency,
      requestedBy,
    };
  }

  private async lockInvoice(tx: DbExecutor, companyId: string, invoiceId: string) {
    const targets = await this.invoicesService.lockTargets(tx, companyId, [invoiceId]);
    const target = targets.get(invoiceId);
    if (!target) throw new NotFoundError('Invoice', invoiceId);
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!row) throw new NotFoundError('Invoice', invoiceId);
    if (
      row.documentType === 'CREDIT_NOTE' ||
      row.accountingStatus !== 'POSTED' ||
      row.status === 'VOID' ||
      row.status === 'DRAFT' ||
      row.status === 'SUBMITTED'
    )
      throw new BusinessRuleError(
        ErrorCodes.WRITE_OFF_INVALID,
        `${row.documentNumber} is not a posted, open receivable.`,
      );
    return row;
  }

  private provisionColumns() {
    return {
      id: badDebtProvisions.id,
      companyId: badDebtProvisions.companyId,
      documentNumber: badDebtProvisions.documentNumber,
      status: badDebtProvisions.status,
      asOf: badDebtProvisions.asOf,
      method: badDebtProvisions.method,
      currency: badDebtProvisions.currency,
      computation: badDebtProvisions.computation,
      requiredAllowance: badDebtProvisions.requiredAllowance,
      existingAllowance: badDebtProvisions.existingAllowance,
      adjustment: badDebtProvisions.adjustment,
      description: badDebtProvisions.description,
      journalEntryId: badDebtProvisions.journalEntryId,
      reversalJournalEntryId: badDebtProvisions.reversalJournalEntryId,
      createdBy: badDebtProvisions.createdBy,
      postedBy: badDebtProvisions.postedBy,
      postedAt: badDebtProvisions.postedAt,
      createdAt: badDebtProvisions.createdAt,
      updatedAt: badDebtProvisions.updatedAt,
    };
  }

  private viewQuery() {
    return this.db
      .select({
        id: writeOffRequests.id,
        companyId: writeOffRequests.companyId,
        branchId: writeOffRequests.branchId,
        documentNumber: writeOffRequests.documentNumber,
        invoiceId: writeOffRequests.invoiceId,
        customerId: writeOffRequests.customerId,
        status: writeOffRequests.status,
        reason: writeOffRequests.reason,
        justification: writeOffRequests.justification,
        currency: writeOffRequests.currency,
        amount: writeOffRequests.amount,
        exchangeRate: writeOffRequests.exchangeRate,
        baseAmount: writeOffRequests.baseAmount,
        writeOffDate: writeOffRequests.writeOffDate,
        debitAccountId: writeOffRequests.debitAccountId,
        journalEntryId: writeOffRequests.journalEntryId,
        recoveryJournalEntryId: writeOffRequests.recoveryJournalEntryId,
        recoveryDate: writeOffRequests.recoveryDate,
        recoveryReason: writeOffRequests.recoveryReason,
        decisionComment: writeOffRequests.decisionComment,
        idempotencyKey: writeOffRequests.idempotencyKey,
        requestedBy: writeOffRequests.requestedBy,
        submittedAt: writeOffRequests.submittedAt,
        approvedBy: writeOffRequests.approvedBy,
        approvedAt: writeOffRequests.approvedAt,
        postedBy: writeOffRequests.postedBy,
        postedAt: writeOffRequests.postedAt,
        createdAt: writeOffRequests.createdAt,
        updatedAt: writeOffRequests.updatedAt,
        customerCode: customers.code,
        customerName: customers.name,
        invoiceNumber: invoices.documentNumber,
        invoiceBalance: sql<string>`${invoices.total} - ${invoices.allocatedAmount}`,
        journalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${writeOffRequests.journalEntryId})`,
        recoveryJournalNumber: sql<
          string | null
        >`(select document_number from journal_entries j where j.id = ${writeOffRequests.recoveryJournalEntryId})`,
        debitAccountCode: sql<
          string | null
        >`(select code from accounts a where a.id = ${writeOffRequests.debitAccountId})`,
        requestedByName: sql<
          string | null
        >`(select first_name || ' ' || last_name from users u where u.id = ${writeOffRequests.requestedBy})`,
      })
      .from(writeOffRequests)
      .innerJoin(invoices, eq(invoices.id, writeOffRequests.invoiceId))
      .innerJoin(customers, eq(customers.id, writeOffRequests.customerId));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<WriteOffRequest> {
    const [row] = await tx
      .select()
      .from(writeOffRequests)
      .where(and(eq(writeOffRequests.id, id), eq(writeOffRequests.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Write-off', id);
    return row;
  }

  private assertStatus(
    doc: WriteOffRequest,
    allowed: WriteOffRequest['status'][],
    verb: string,
  ): void {
    if (!allowed.includes(doc.status))
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${doc.documentNumber} cannot be ${verb} from status ${doc.status}.`,
        { status: doc.status, allowed },
      );
  }
}
