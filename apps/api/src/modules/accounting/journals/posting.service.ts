import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Money } from '@accounting/money';
import type { JournalType } from '@accounting/types';
import { AuditService } from '@/modules/audit/audit.service';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  fiscalPeriods,
  journalEntries,
  journalLines,
  type Account,
  type JournalEntry,
} from '@/database/schema';
import { DocumentNumberingService } from '../numbering/document-numbering.service';

const MODULE = 'ACCOUNTING';

/** A line as supplied by callers: amounts are decimal strings, never numbers. */
export interface PostingLine {
  accountId: string;
  debit: string;
  credit: string;
  description?: string | null;
  branchId?: string | null;
  /** Cost-accounting dimensions (Phase 7); validated by the calling module. */
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
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
  actorId: string | null;
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
 * The posting engine. Every ledger write in the system goes through here.
 *
 * Responsibilities (see docs/accounting-engine.md):
 *  - validate accounts (exist, active, postable, same company)
 *  - validate the fiscal period is open for the entry date
 *  - validate SUM(debit) = SUM(credit) with exact decimal arithmetic
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
    private readonly events: EventEmitter2,
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
      if (account.currency && account.currency !== currency) {
        throw new BusinessRuleError(
          ErrorCodes.CURRENCY_MISMATCH,
          `Line ${index + 1}: ${account.code} is a ${account.currency} account; this journal is in ${currency}.`,
          { line: index + 1 },
        );
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

  /** Finds the period for a date and asserts it is open (unless explicitly allowed). */
  async resolvePeriod(
    tx: DbExecutor,
    companyId: string,
    entryDate: string,
    options: PostOptions = {},
  ) {
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
    if (period.status === 'CLOSED' && !options.allowClosedPeriod) {
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNTING_PERIOD_CLOSED,
        `The accounting period ${period.name} is closed.`,
        { periodId: period.id, period: period.name },
      );
    }
    return period;
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
    const period = await this.resolvePeriod(tx, event.companyId, event.entryDate, options);
    const documentNumber = await this.numbering.allocate(
      event.companyId,
      'JE',
      Number(event.entryDate.slice(0, 4)),
      tx,
    );

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
        description: event.description,
        reference: event.reference ?? null,
        currency,
        totalDebit: validated.totalDebit.toString(),
        totalCredit: validated.totalCredit.toString(),
        sourceType: event.sourceType ?? null,
        sourceId: event.sourceId ?? null,
        idempotencyKey: event.idempotencyKey ?? null,
        reversalOfId: event.reversalOfId ?? null,
        createdBy: event.actorId,
        approvedBy: event.actorId,
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
      })),
    );

    return this.postEntry(tx, entry.id, event.actorId, options);
  }

  /** Posts an APPROVED entry that already exists (document workflow path). */
  async postEntry(
    tx: DbExecutor,
    entryId: string,
    actorId: string | null,
    options: PostOptions = {},
  ): Promise<JournalEntry> {
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
    const validated = await this.validateLines(
      tx,
      entry.companyId,
      entry.currency,
      lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
    );
    const period = await this.resolvePeriod(tx, entry.companyId, entry.entryDate, options);

    const [posted] = await tx
      .update(journalEntries)
      .set({
        status: 'POSTED',
        fiscalPeriodId: period.id,
        postingDate: entry.entryDate,
        totalDebit: validated.totalDebit.toString(),
        totalCredit: validated.totalCredit.toString(),
        postedBy: actorId,
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
        },
        companyId: posted.companyId,
        userId: actorId,
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
    this.events.emit(JOURNAL_POSTED_EVENT, payload);
    return posted;
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
