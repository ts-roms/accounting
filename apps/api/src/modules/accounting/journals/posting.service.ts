import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { PinoLogger } from 'nestjs-pino';
import { Money } from '@accounting/money';
import { P, type JournalType, type PermissionKey } from '@accounting/types';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { BusinessRuleError, PermissionDeniedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  bankTransactions,
  branches,
  companies,
  apAccruals,
  bankTransfers,
  pettyCashVouchers,
  badDebtProvisions,
  customerPayments,
  deliveries,
  depreciationRuns,
  expenseClaims,
  fiscalPeriods,
  fixedAssets,
  fxRevaluations,
  goodsReceipts,
  invoices,
  journalEntries,
  journalLines,
  payRuns,
  leases,
  leaseRuns,
  leaseScheduleLines,
  leaseEvents,
  revenueRecognitionRuns,
  stockDocuments,
  vendorBills,
  vendorPayments,
  writeOffRequests,
  type Account,
  type FiscalPeriod,
  type JournalEntry,
} from '@/database/schema';
import { DimensionRulesService } from '../dimensions/dimension-rules.service';
import { DimensionsService } from '../dimensions/dimensions.service';
import { DocumentNumberingService } from '../numbering/document-numbering.service';

const MODULE = 'ACCOUNTING';

/** A line as supplied by callers: amounts are decimal strings, never numbers. */
export interface PostingLine {
  accountId: string;
  debit: string;
  credit: string;
  description?: string | null;
  branchId?: string | null;
  /** Cost-accounting dimensions (Phase 7); validated here before any row is written. */
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  /**
   * Foreign amount beside the base amount, in `foreignCurrency`. Required on a
   * line that hits an account bound to a currency (the account's foreign balance
   * is the sum of these); manual foreign journals carry it on every line.
   */
  foreignDebit?: string | null;
  foreignCredit?: string | null;
  foreignCurrency?: string | null;
  exchangeRate?: string | null;
}

/**
 * Who is posting. A user principal carries its effective permissions; the
 * scheduler principal is marked `system` and is gated by configuration instead.
 */
export interface PostingActor {
  id: string | null;
  permissions?: ReadonlySet<string>;
  system?: boolean;
}

/**
 * An accounting event: what a business module wants recorded in the ledger.
 * Modules build one of these and hand it to `postEvent`; they never write
 * journal rows themselves.
 */
export interface AccountingEvent {
  companyId: string;
  entryDate: string;
  description: string;
  reference?: string | null;
  journalType?: JournalType;
  branchId?: string | null;
  lines: PostingLine[];
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey?: string | null;
  reversalOfId?: string | null;
  /** Date on the underlying document when it differs from the accounting date. */
  documentDate?: string | null;
  /** Set when the lines were entered in a foreign currency (amounts are already base). */
  transactionCurrency?: string | null;
  exchangeRate?: string | null;
  /** Accruals: a mirror REVERSAL is posted on this date right after posting. */
  autoReverseDate?: string | null;
  actor: PostingActor;
}

export interface ValidatedLines {
  currency: string;
  totalDebit: Money;
  totalCredit: Money;
  accountsById: Map<string, Account>;
}

export interface PostOptions {
  /** Only the year-end closing routine may post into a closed period. */
  allowClosedPeriod?: boolean;
  /** Resolving the period for a DRAFT: soft-closed is fine, posting is gated later. */
  draft?: boolean;
  /**
   * Authority the actor must hold for this posting. Subledger modules pass
   * their own posting permission (`bill.post`, `depreciation.run`, ...);
   * manual journals use the default `journal.post`.
   */
  permission?: PermissionKey;
  /**
   * A JE number this transaction already allocated for the journal (see the
   * auto-reversal in `postEntry`). Internal: callers never choose numbers.
   */
  preallocatedNumber?: string;
}

export const JOURNAL_POSTED_EVENT = 'accounting.journal.posted';

export interface JournalPostedEvent {
  companyId: string;
  journalEntryId: string;
  documentNumber: string;
  entryDate: string;
  journalType: JournalType;
  sourceType: string | null;
  sourceId: string | null;
  totalDebit: string;
  totalCredit: string;
}

/**
 * Source documents the gateway can verify. A posting that names one of these
 * types must point at a row of the company; unknown types are allowed (the
 * unique (company, sourceType, sourceId) index still guards duplicates).
 */
const SOURCE_TABLES = {
  AR_DOCUMENT: invoices,
  AR_DOCUMENT_VOID: invoices,
  DELIVERY: deliveries,
  DELIVERY_CANCEL: deliveries,
  AR_WRITE_OFF: writeOffRequests,
  AR_WRITE_OFF_RECOVERY: writeOffRequests,
  AR_PROVISION: badDebtProvisions,
  AR_PROVISION_REVERSAL: badDebtProvisions,
  AP_ACCRUAL: apAccruals,
  AP_ACCRUAL_REVERSAL: apAccruals,
  BANK_TRANSFER_OUT: bankTransfers,
  BANK_TRANSFER_IN: bankTransfers,
  PETTY_CASH_VOUCHER: pettyCashVouchers,
  PETTY_CASH_VOUCHER_VOID: pettyCashVouchers,
  AP_DOCUMENT: vendorBills,
  AP_DOCUMENT_VOID: vendorBills,
  AR_PAYMENT: customerPayments,
  AR_PAYMENT_VOID: customerPayments,
  AP_PAYMENT: vendorPayments,
  AP_PAYMENT_VOID: vendorPayments,
  BANK_TRANSACTION: bankTransactions,
  BANK_TRANSACTION_VOID: bankTransactions,
  DEPRECIATION_RUN: depreciationRuns,
  DEPRECIATION_RUN_REVERSAL: depreciationRuns,
  FIXED_ASSET_CAPITALIZATION: fixedAssets,
  FIXED_ASSET_OPENING_DEPRECIATION: fixedAssets,
  FIXED_ASSET_IMPAIRMENT: fixedAssets,
  FIXED_ASSET_REVALUATION: fixedAssets,
  FIXED_ASSET_DISPOSAL: fixedAssets,
  EXPENSE_CLAIM: expenseClaims,
  EXPENSE_CLAIM_PAYMENT: expenseClaims,
  GOODS_RECEIPT: goodsReceipts,
  GOODS_RECEIPT_CANCEL: goodsReceipts,
  STOCK_DOCUMENT: stockDocuments,
  FX_REVALUATION: fxRevaluations,
  FX_REVALUATION_REVERSAL: fxRevaluations,
  JOURNAL_REVERSAL: journalEntries,
  REVENUE_RECOGNITION_RUN: revenueRecognitionRuns,
  PAY_RUN: payRuns,
  PAY_RUN_PAYMENT: payRuns,
  LEASE_COMMENCEMENT: leases,
  LEASE_TERMINATION: leases,
  LEASE_RUN: leaseRuns,
  LEASE_PAYMENT: leaseScheduleLines,
  LEASE_REMEASUREMENT: leaseEvents,
} as const satisfies Record<string, SourceTable>;

/** Shape every verifiable source table shares. */
type SourceTable = { id: PgColumn; companyId: PgColumn } & PgTable;

/**
 * The posting engine. Every ledger write in the system goes through here.
 *
 * Responsibilities (see docs/accounting-engine.md and docs/accounting-controls.md):
 *  - validate the actor's authority for this posting
 *  - validate accounts (exist, active, postable, same company, currency)
 *  - validate branches and cost dimensions belong to the company and are active
 *  - validate the source document exists in the company
 *  - validate the fiscal period state (OPEN / SOFT_CLOSED / CLOSED / LOCKED)
 *  - validate SUM(debit) = SUM(credit) with exact decimal arithmetic
 *  - guarantee idempotency on idempotency key and source document
 *  - assign posting date/status/actor, write the audit entry, emit an event
 *
 * It never opens its own transaction: callers pass the transaction that also
 * carries their business change, so both commit or roll back together.
 */
@Injectable()
export class AccountingPostingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly dimensions: DimensionsService,
    private readonly dimensionRules: DimensionRulesService,
    private readonly events: EventEmitter2,
    private readonly outbox: OutboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountingPostingService.name);
  }

  /** Pure validation of a line set - used by the document service on every save. */
  async validateLines(
    tx: DbExecutor,
    companyId: string,
    currency: string,
    lines: PostingLine[],
  ): Promise<ValidatedLines> {
    if (lines.length < 2) {
      throw new BusinessRuleError(
        ErrorCodes.JOURNAL_UNBALANCED,
        'A journal entry needs at least two lines.',
      );
    }
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const rows =
      ids.length > 0
        ? await tx
            .select()
            .from(accounts)
            .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, ids)))
        : [];
    const accountsById = new Map(rows.map((a) => [a.id, a]));

    let totalDebit = Money.zero(currency);
    let totalCredit = Money.zero(currency);
    lines.forEach((line, index) => {
      const account = accountsById.get(line.accountId);
      if (!account) {
        throw new BusinessRuleError(
          ErrorCodes.NOT_FOUND,
          `Line ${index + 1}: account does not exist in this company.`,
          { line: index + 1 },
        );
      }
      if (account.isHeader) {
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `Line ${index + 1}: ${account.code} ${account.name} is a header account.`,
          { line: index + 1 },
        );
      }
      if (account.status !== 'ACTIVE') {
        throw new BusinessRuleError(
          ErrorCodes.GL_ACCOUNT_INACTIVE,
          `Line ${index + 1}: ${account.code} ${account.name} is inactive.`,
          { line: index + 1 },
        );
      }
      const hasForeign = line.foreignDebit != null || line.foreignCredit != null;
      if (hasForeign && !line.foreignCurrency) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Line ${index + 1}: a foreign amount needs its currency.`,
          { line: index + 1 },
        );
      }
      if (line.foreignCurrency && line.foreignCurrency === currency) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Line ${index + 1}: the foreign currency cannot be the base currency ${currency}.`,
          { line: index + 1 },
        );
      }
      // An account bound to a currency only takes lines that carry their amount in that
      // currency, so its foreign balance stays derivable from the ledger.
      if (account.currency && account.currency !== currency) {
        if (line.foreignCurrency !== account.currency) {
          throw new BusinessRuleError(
            ErrorCodes.CURRENCY_MISMATCH,
            `Line ${index + 1}: ${account.code} is a ${account.currency} account; the line must carry its ${account.currency} amount${line.foreignCurrency ? ` (got ${line.foreignCurrency})` : ''}.`,
            { line: index + 1 },
          );
        }
      }
      const debit = Money.parse(line.debit, currency);
      const credit = Money.parse(line.credit, currency);
      if (debit.isNegative() || credit.isNegative()) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Line ${index + 1}: amounts cannot be negative.`,
          { line: index + 1 },
        );
      }
      if (debit.isPositive() && credit.isPositive()) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Line ${index + 1}: a line carries either a debit or a credit.`,
          { line: index + 1 },
        );
      }
      if (debit.isZero() && credit.isZero()) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Line ${index + 1}: amount is zero.`,
          { line: index + 1 },
        );
      }
      totalDebit = totalDebit.add(debit);
      totalCredit = totalCredit.add(credit);
    });

    if (!totalDebit.equals(totalCredit)) {
      throw new BusinessRuleError(
        ErrorCodes.JOURNAL_UNBALANCED,
        `Journal entry is out of balance: debits ${totalDebit.toString()} vs credits ${totalCredit.toString()}.`,
        {
          totalDebit: totalDebit.toString(),
          totalCredit: totalCredit.toString(),
          difference: totalDebit.subtract(totalCredit).toString(),
        },
      );
    }
    return { currency, totalDebit, totalCredit, accountsById };
  }

  /**
   * Accounts restricted to branches (`allowed_branch_ids`) reject lines posted
   * from any other branch; a line without a branch inherits the header's.
   */
  assertAccountBranches(
    accountsById: ReadonlyMap<string, Account>,
    headerBranchId: string | null | undefined,
    lines: readonly PostingLine[],
  ): void {
    lines.forEach((line, index) => {
      const account = accountsById.get(line.accountId);
      if (!account || account.allowedBranchIds.length === 0) return;
      const branchId = line.branchId ?? headerBranchId ?? null;
      if (!branchId || !account.allowedBranchIds.includes(branchId)) {
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_BRANCH_NOT_ALLOWED,
          `Line ${index + 1}: ${account.code} ${account.name} cannot be posted from this branch.`,
          { line: index + 1, accountId: account.id, branchId },
        );
      }
    });
  }

  /** Branch, dimension and dimension-rule validation shared by both posting paths. */
  private async validateForPosting(
    tx: DbExecutor,
    companyId: string,
    headerBranchId: string | null | undefined,
    entryDate: string,
    validated: ValidatedLines,
    lines: readonly PostingLine[],
  ): Promise<void> {
    this.assertAccountBranches(validated.accountsById, headerBranchId, lines);
    await this.validateBranches(tx, companyId, headerBranchId, lines);
    await this.dimensions.validateRefs(tx, companyId, lines, entryDate);
    await this.dimensionRules.assertLines(tx, companyId, lines, validated.accountsById);
  }

  /** Branches on the header / lines must belong to the company and be active. */
  async validateBranches(
    tx: DbExecutor,
    companyId: string,
    headerBranchId: string | null | undefined,
    lines: readonly PostingLine[],
  ): Promise<void> {
    const ids = [
      ...new Set(
        [headerBranchId, ...lines.map((l) => l.branchId)].filter((x): x is string => Boolean(x)),
      ),
    ];
    if (!ids.length) return;
    const rows = await tx
      .select({ id: branches.id, status: branches.status, code: branches.code })
      .from(branches)
      .where(and(eq(branches.companyId, companyId), inArray(branches.id, ids)));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const b = found.get(id);
      if (!b)
        throw new BusinessRuleError(
          ErrorCodes.NOT_FOUND,
          'Branch does not exist in this company.',
          {
            branchId: id,
          },
        );
      if (b.status !== 'ACTIVE')
        throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, `Branch ${b.code} is inactive.`, {
          branchId: id,
        });
    }
  }

  /** The named source document must exist in the company (for the types the gateway knows). */
  async validateSource(
    tx: DbExecutor,
    companyId: string,
    sourceType: string | null | undefined,
    sourceId: string | null | undefined,
  ): Promise<void> {
    if (!sourceType && !sourceId) return;
    if (!sourceType || !sourceId)
      throw new BusinessRuleError(
        ErrorCodes.SOURCE_DOCUMENT_INVALID,
        'A source document needs both a type and an id.',
        { sourceType, sourceId },
      );
    const table: SourceTable | undefined = SOURCE_TABLES[sourceType as keyof typeof SOURCE_TABLES];
    if (!table) return;
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, sourceId), eq(table.companyId, companyId)));
    if (!row)
      throw new BusinessRuleError(
        ErrorCodes.SOURCE_DOCUMENT_INVALID,
        `Source ${sourceType} ${sourceId} does not exist in this company.`,
        { sourceType, sourceId },
      );
  }

  /**
   * Finds the period for a date and asserts the actor may post into it:
   * OPEN always; SOFT_CLOSED with `period.post-soft-closed` (or a system
   * posting); CLOSED only for the year-end routine; LOCKED never.
   */
  async resolvePeriod(
    tx: DbExecutor,
    companyId: string,
    entryDate: string,
    options: PostOptions = {},
    actor?: PostingActor,
  ): Promise<FiscalPeriod> {
    const [period] = await tx
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.companyId, companyId),
          lte(fiscalPeriods.startDate, entryDate),
          gte(fiscalPeriods.endDate, entryDate),
        ),
      );
    if (!period) {
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNTING_PERIOD_NOT_FOUND,
        `No fiscal period covers ${entryDate}.`,
        { date: entryDate },
      );
    }
    const details = { periodId: period.id, period: period.name, status: period.status };
    switch (period.status) {
      case 'OPEN':
        return period;
      case 'LOCKED':
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNTING_PERIOD_LOCKED,
          `The accounting period ${period.name} is locked; nothing can be posted into it.`,
          details,
        );
      case 'CLOSED':
        if (options.allowClosedPeriod) return period;
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNTING_PERIOD_CLOSED,
          `The accounting period ${period.name} is closed.`,
          details,
        );
      case 'SOFT_CLOSED': {
        const allowed =
          options.draft ||
          options.allowClosedPeriod ||
          actor?.system ||
          actor?.permissions?.has(P['period.post-soft-closed']);
        if (allowed) return period;
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNTING_PERIOD_SOFT_CLOSED,
          `The accounting period ${period.name} is soft-closed; posting needs the "post into soft-closed periods" permission.`,
          { ...details, required: P['period.post-soft-closed'] },
        );
      }
    }
  }

  /** The actor must hold the posting authority named by the caller (default `journal.post`). */
  assertAuthority(actor: PostingActor, options: PostOptions = {}): void {
    if (actor.system) return;
    const required = options.permission ?? P['journal.post'];
    if (!actor.permissions) throw new PermissionDeniedError([required]);
    if (!actor.permissions.has(required)) throw new PermissionDeniedError([required]);
  }

  /**
   * Creates and posts a journal in one step. Idempotent on
   * (company, idempotencyKey) and on (company, sourceType, sourceId): a repeat
   * call returns the existing posted entry instead of double posting.
   */
  async postEvent(
    tx: DbExecutor,
    event: AccountingEvent,
    options: PostOptions = {},
  ): Promise<JournalEntry> {
    this.assertAuthority(event.actor, options);
    const existing = await this.findExisting(tx, event);
    if (existing) {
      this.logger.info(
        { documentNumber: existing.documentNumber },
        'Idempotent replay of accounting event',
      );
      return existing;
    }

    const currency = await this.companyCurrency(tx, event.companyId);
    const validated = await this.validateLines(tx, event.companyId, currency, event.lines);
    await this.validateForPosting(
      tx,
      event.companyId,
      event.branchId,
      event.entryDate,
      validated,
      event.lines,
    );
    await this.validateSource(tx, event.companyId, event.sourceType, event.sourceId);
    const period = await this.resolvePeriod(
      tx,
      event.companyId,
      event.entryDate,
      options,
      event.actor,
    );
    const documentNumber =
      options.preallocatedNumber ??
      (await this.numbering.allocate(
        event.companyId,
        'JE',
        Number(event.entryDate.slice(0, 4)),
        tx,
      ));

    const [entry] = await tx
      .insert(journalEntries)
      .values({
        companyId: event.companyId,
        branchId: event.branchId ?? null,
        fiscalPeriodId: period.id,
        documentNumber,
        journalType: event.journalType ?? 'GENERAL',
        status: 'APPROVED',
        entryDate: event.entryDate,
        documentDate: event.documentDate ?? null,
        autoReverseDate: event.autoReverseDate ?? null,
        description: event.description,
        reference: event.reference ?? null,
        currency,
        transactionCurrency: event.transactionCurrency ?? null,
        exchangeRate: event.transactionCurrency ? (event.exchangeRate ?? null) : null,
        totalDebit: validated.totalDebit.toString(),
        totalCredit: validated.totalCredit.toString(),
        sourceType: event.sourceType ?? null,
        sourceId: event.sourceId ?? null,
        idempotencyKey: event.idempotencyKey ?? null,
        reversalOfId: event.reversalOfId ?? null,
        createdBy: event.actor.id,
        approvedBy: event.actor.id,
        approvedAt: new Date(),
      })
      .returning();
    if (!entry) throw new Error('Insert returned no row');

    await tx.insert(journalLines).values(
      event.lines.map((line, index) => ({
        journalEntryId: entry.id,
        companyId: event.companyId,
        lineNumber: index + 1,
        accountId: line.accountId,
        description: line.description ?? null,
        debit: Money.parse(line.debit, currency).toString(),
        credit: Money.parse(line.credit, currency).toString(),
        branchId: line.branchId ?? event.branchId ?? null,
        departmentId: line.departmentId ?? null,
        costCenterId: line.costCenterId ?? null,
        projectId: line.projectId ?? null,
        foreignDebit: line.foreignDebit ?? null,
        foreignCredit: line.foreignCredit ?? null,
        foreignCurrency: line.foreignCurrency ?? null,
        exchangeRate: line.exchangeRate ?? null,
      })),
    );

    return this.postEntry(tx, entry.id, event.actor, options);
  }

  /** Posts an APPROVED entry that already exists (document workflow path). */
  async postEntry(
    tx: DbExecutor,
    entryId: string,
    actor: PostingActor,
    options: PostOptions = {},
  ): Promise<JournalEntry> {
    this.assertAuthority(actor, options);
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId))
      .for('update');
    if (!entry) throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'Journal entry not found.');
    if (entry.status === 'POSTED' || entry.status === 'LOCKED' || entry.status === 'REVERSED') {
      // Idempotent: posting twice is a no-op.
      return entry;
    }
    if (entry.status !== 'APPROVED') {
      throw new BusinessRuleError(
        ErrorCodes.JOURNAL_INVALID_STATE,
        `Only approved entries can be posted (current status: ${entry.status}).`,
        { status: entry.status },
      );
    }

    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id))
      .orderBy(asc(journalLines.lineNumber));
    const validated = await this.validateLines(tx, entry.companyId, entry.currency, lines);
    await this.validateForPosting(
      tx,
      entry.companyId,
      entry.branchId,
      entry.entryDate,
      validated,
      lines,
    );
    const period = await this.resolvePeriod(tx, entry.companyId, entry.entryDate, options, actor);

    // Lock order: every posting takes the JE counter row before the period-balance rows the
    // status flip below updates. An accrual's mirror REVERSAL needs a number too, so it is
    // allocated now - taking it after the flip would invert the order against concurrent
    // postEvent calls and deadlock them.
    const reversalNumber = entry.autoReverseDate
      ? await this.numbering.allocate(
          entry.companyId,
          'JE',
          Number(entry.autoReverseDate.slice(0, 4)),
          tx,
        )
      : undefined;

    const [posted] = await tx
      .update(journalEntries)
      .set({
        status: 'POSTED',
        fiscalPeriodId: period.id,
        postingDate: entry.entryDate,
        totalDebit: validated.totalDebit.toString(),
        totalCredit: validated.totalCredit.toString(),
        postedBy: actor.id,
        postedAt: new Date(),
      })
      .where(eq(journalEntries.id, entry.id))
      .returning();
    if (!posted) throw new Error('Update returned no row');

    await this.audit.record(
      {
        action: 'POST',
        module: MODULE,
        entityType: 'JournalEntry',
        entityId: posted.id,
        previousValue: { status: entry.status },
        newValue: {
          status: 'POSTED',
          postingDate: posted.postingDate,
          totalDebit: posted.totalDebit,
          totalCredit: posted.totalCredit,
        },
        metadata: {
          documentNumber: posted.documentNumber,
          journalType: posted.journalType,
          lines: lines.length,
          periodStatus: period.status,
          authority: options.permission ?? P['journal.post'],
          system: Boolean(actor.system),
        },
        companyId: posted.companyId,
        userId: actor.id,
      },
      tx,
    );

    const payload: JournalPostedEvent = {
      companyId: posted.companyId,
      journalEntryId: posted.id,
      documentNumber: posted.documentNumber,
      entryDate: posted.entryDate,
      journalType: posted.journalType,
      sourceType: posted.sourceType,
      sourceId: posted.sourceId,
      totalDebit: posted.totalDebit,
      totalCredit: posted.totalCredit,
    };
    // Transactional outbox: the outbound webhook event commits with the ledger write.
    await this.outbox.enqueue(tx, {
      eventType: posted.journalType === 'REVERSAL' ? 'journal.reversed' : 'journal.posted',
      companyId: posted.companyId,
      dedupeKey: `journal.posted:${posted.id}`,
      payload: {
        ...payload,
        reversalOfId: posted.reversalOfId ?? null,
        description: posted.description,
      },
    });
    this.events.emit(JOURNAL_POSTED_EVENT, payload);

    // Accruals: the mirror entry posts now, dated in the next period, under the
    // same authority - it is part of the accrual, not a separate decision.
    if (posted.autoReverseDate) {
      const reversal = await this.reverseEntry(tx, posted, {
        documentNumber: reversalNumber,
        reversalDate: posted.autoReverseDate,
        description: `Auto-reversal of ${posted.documentNumber}: ${posted.description}`,
        actor,
        permission: options.permission ?? P['journal.post'],
      });
      return { ...posted, status: 'REVERSED', reversedById: reversal.id };
    }
    return posted;
  }

  /**
   * Posts the mirror image of a ledger entry as a REVERSAL and marks the
   * original REVERSED (it stays in the ledger). Idempotent per original through
   * the JOURNAL_REVERSAL source identity. Manual reversals, corrections and
   * auto-reversing accruals all come through here.
   */
  async reverseEntry(
    tx: DbExecutor,
    entry: JournalEntry,
    input: {
      reversalDate: string;
      description?: string | null;
      actor: PostingActor;
      permission?: PermissionKey;
      /** Number allocated earlier in this transaction (auto-reversal lock order). */
      documentNumber?: string;
    },
  ): Promise<JournalEntry> {
    if (!(entry.status === 'POSTED' || entry.status === 'LOCKED')) {
      throw new BusinessRuleError(
        ErrorCodes.JOURNAL_INVALID_STATE,
        `Only posted entries can be reversed (current status: ${entry.status}).`,
        { status: entry.status },
      );
    }
    if (input.reversalDate < entry.entryDate) {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'The reversal date cannot be before the original entry date.',
      );
    }
    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id))
      .orderBy(asc(journalLines.lineNumber));
    const reversal = await this.postEvent(
      tx,
      {
        companyId: entry.companyId,
        entryDate: input.reversalDate,
        description:
          input.description ?? `Reversal of ${entry.documentNumber}: ${entry.description}`,
        reference: entry.documentNumber,
        journalType: 'REVERSAL',
        branchId: entry.branchId,
        transactionCurrency: entry.transactionCurrency,
        exchangeRate: entry.exchangeRate,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          description: l.description,
          debit: l.credit,
          credit: l.debit,
          branchId: l.branchId,
          departmentId: l.departmentId,
          costCenterId: l.costCenterId,
          projectId: l.projectId,
          foreignDebit: l.foreignCredit,
          foreignCredit: l.foreignDebit,
          foreignCurrency: l.foreignCurrency,
          exchangeRate: l.exchangeRate,
        })),
        sourceType: 'JOURNAL_REVERSAL',
        sourceId: entry.id,
        reversalOfId: entry.id,
        actor: input.actor,
      },
      {
        permission: input.permission ?? P['journal.reverse'],
        preallocatedNumber: input.documentNumber,
      },
    );
    await tx
      .update(journalEntries)
      .set({ status: 'REVERSED', reversedById: reversal.id })
      .where(eq(journalEntries.id, entry.id));
    await this.audit.record(
      {
        action: 'REVERSE',
        module: MODULE,
        entityType: 'JournalEntry',
        entityId: entry.id,
        previousValue: { status: entry.status },
        newValue: { status: 'REVERSED', reversedById: reversal.id },
        metadata: {
          documentNumber: entry.documentNumber,
          reversalDocumentNumber: reversal.documentNumber,
          automatic: entry.autoReverseDate === input.reversalDate,
        },
        companyId: entry.companyId,
        userId: input.actor.id,
      },
      tx,
    );
    return reversal;
  }

  private async findExisting(
    tx: DbExecutor,
    event: AccountingEvent,
  ): Promise<JournalEntry | undefined> {
    if (event.idempotencyKey) {
      const [row] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.companyId, event.companyId),
            eq(journalEntries.idempotencyKey, event.idempotencyKey),
          ),
        );
      if (row) return row;
    }
    if (event.sourceType && event.sourceId) {
      const [row] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.companyId, event.companyId),
            eq(journalEntries.sourceType, event.sourceType),
            eq(journalEntries.sourceId, event.sourceId),
          ),
        );
      if (row) return row;
    }
    return undefined;
  }

  private async companyCurrency(tx: DbExecutor, companyId: string): Promise<string> {
    const [row] = await tx
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'Company not found.');
    return row.baseCurrency;
  }
}
