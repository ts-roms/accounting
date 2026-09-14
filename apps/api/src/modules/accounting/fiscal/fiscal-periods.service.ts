import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { INCOME_STATEMENT_TYPES, LEDGER_STATUSES, P } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import type { CreateFiscalYearInput } from '@accounting/validation';
import { Money } from '@accounting/money';
import { AuditService } from '@/modules/audit/audit.service';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  fiscalPeriods,
  fiscalYears,
  journalEntries,
  journalLines,
  type FiscalPeriod,
  type FiscalYear,
} from '@/database/schema';
import { AccountsService } from '../accounts/accounts.service';
import { AccountingPostingService } from '../journals/posting.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';

const MODULE = 'ACCOUNTING';
const UNPOSTED = ['DRAFT', 'SUBMITTED', 'APPROVED'] as const;

export interface FiscalYearWithPeriods extends FiscalYear {
  periods: FiscalPeriod[];
}

/** Date helpers on ISO strings - business dates never touch timezones. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return date.toISOString().slice(0, 10);
}
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

@Injectable()
export class FiscalPeriodsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accountsService: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly outbox: OutboxService,
  ) {}

  async listYears(companyId: string): Promise<FiscalYearWithPeriods[]> {
    const years = await this.db
      .select()
      .from(fiscalYears)
      .where(eq(fiscalYears.companyId, companyId))
      .orderBy(desc(fiscalYears.startDate));
    if (years.length === 0) return [];
    const periods = await this.db
      .select()
      .from(fiscalPeriods)
      .where(
        inArray(
          fiscalPeriods.fiscalYearId,
          years.map((y) => y.id),
        ),
      )
      .orderBy(asc(fiscalPeriods.periodNumber));
    return years.map((y) => ({ ...y, periods: periods.filter((p) => p.fiscalYearId === y.id) }));
  }

  async getYearOrThrow(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<FiscalYear> {
    const [row] = await executor
      .select()
      .from(fiscalYears)
      .where(and(eq(fiscalYears.id, id), eq(fiscalYears.companyId, companyId)));
    if (!row) throw new NotFoundError('Fiscal year', id);
    return row;
  }

  async getPeriodOrThrow(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<FiscalPeriod> {
    const [row] = await executor
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.id, id), eq(fiscalPeriods.companyId, companyId)));
    if (!row) throw new NotFoundError('Fiscal period', id);
    return row;
  }

  /** The period containing a business date, or an error if the calendar does not cover it. */
  async periodForDate(
    companyId: string,
    isoDate: string,
    executor: DbExecutor = this.db,
  ): Promise<FiscalPeriod> {
    const [row] = await executor
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.companyId, companyId),
          lte(fiscalPeriods.startDate, isoDate),
          gte(fiscalPeriods.endDate, isoDate),
        ),
      );
    if (!row) {
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNTING_PERIOD_NOT_FOUND,
        `No fiscal period covers ${isoDate}. Create the fiscal year first.`,
        { date: isoDate },
      );
    }
    return row;
  }

  /** Creates a fiscal year of 12 monthly periods starting on `startDate`. */
  async createYear(
    companyId: string,
    input: CreateFiscalYearInput,
  ): Promise<FiscalYearWithPeriods> {
    return this.db.transaction(async (tx) => {
      const [company] = await tx
        .select({ month: companies.fiscalYearStartMonth })
        .from(companies)
        .where(eq(companies.id, companyId));
      if (!company) throw new NotFoundError('Company', companyId);

      const startDate = input.startDate;
      if (!startDate.endsWith('-01')) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A fiscal year must start on the first day of a month.',
        );
      }
      const endDate = addDays(addMonths(startDate, 12), -1);
      const startYear = Number(startDate.slice(0, 4));
      const endYear = Number(endDate.slice(0, 4));
      const name =
        input.name ??
        (startYear === endYear ? `FY${startYear}` : `FY${startYear}-${String(endYear).slice(2)}`);

      const [overlap] = await tx
        .select({ id: fiscalYears.id, name: fiscalYears.name })
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.companyId, companyId),
            lte(fiscalYears.startDate, endDate),
            gte(fiscalYears.endDate, startDate),
          ),
        );
      if (overlap) {
        throw new BusinessRuleError(
          ErrorCodes.FISCAL_YEAR_OVERLAP,
          `The requested range overlaps fiscal year ${overlap.name}.`,
        );
      }

      const [year] = await tx
        .insert(fiscalYears)
        .values({ companyId, name, startDate, endDate })
        .returning();
      if (!year) throw new Error('Insert returned no row');

      const periodRows = Array.from({ length: 12 }, (_, i) => {
        const pStart = addMonths(startDate, i);
        const month = Number(pStart.slice(5, 7));
        return {
          fiscalYearId: year.id,
          companyId,
          periodNumber: i + 1,
          name: `${MONTH_NAMES[month - 1]} ${pStart.slice(0, 4)}`,
          startDate: pStart,
          endDate: endOfMonth(pStart),
        };
      });
      const periods = await tx.insert(fiscalPeriods).values(periodRows).returning();

      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'FiscalYear',
          entityId: year.id,
          newValue: { ...year, periods: periods.length },
          companyId,
        },
        tx,
      );
      return { ...year, periods };
    });
  }

  async closePeriod(
    companyId: string,
    periodId: string,
    actorId: string,
    reason?: string,
  ): Promise<FiscalPeriod> {
    return this.db.transaction(async (tx) => {
      const period = await this.lockPeriodRow(companyId, periodId, tx);
      if (period.status === 'CLOSED' || period.status === 'LOCKED') {
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          `${period.name} is already ${period.status.toLowerCase()}.`,
        );
      }
      const year = await this.getYearOrThrow(companyId, period.fiscalYearId, tx);
      if (year.status === 'CLOSED')
        throw new BusinessRuleError(ErrorCodes.FISCAL_YEAR_CLOSED, `${year.name} is closed.`);

      // Periods close in sequence so balances roll forward deterministically.
      const [earlierOpen] = await tx
        .select({ name: fiscalPeriods.name })
        .from(fiscalPeriods)
        .where(
          and(
            eq(fiscalPeriods.fiscalYearId, year.id),
            sql`${fiscalPeriods.periodNumber} < ${period.periodNumber}`,
            inArray(fiscalPeriods.status, ['OPEN', 'SOFT_CLOSED']),
          ),
        )
        .orderBy(asc(fiscalPeriods.periodNumber))
        .limit(1);
      if (earlierOpen) {
        throw new BusinessRuleError(
          ErrorCodes.PERIOD_SEQUENCE_VIOLATION,
          `Close ${earlierOpen.name} before ${period.name}.`,
        );
      }

      const unposted = await tx
        .select({ documentNumber: journalEntries.documentNumber, status: journalEntries.status })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.fiscalPeriodId, period.id),
            inArray(journalEntries.status, [...UNPOSTED]),
          ),
        );
      if (unposted.length > 0) {
        throw new BusinessRuleError(
          ErrorCodes.PERIOD_HAS_UNPOSTED_ENTRIES,
          `${period.name} has ${unposted.length} unposted journal entr${unposted.length === 1 ? 'y' : 'ies'}. Post or reject them first.`,
          { entries: unposted.slice(0, 20) },
        );
      }

      const [closed] = await tx
        .update(fiscalPeriods)
        .set({ status: 'CLOSED', closedAt: new Date(), closedBy: actorId })
        .where(eq(fiscalPeriods.id, period.id))
        .returning();
      if (!closed) throw new Error('Update returned no row');

      const locked = await tx
        .update(journalEntries)
        .set({ status: 'LOCKED' })
        .where(
          and(eq(journalEntries.fiscalPeriodId, period.id), eq(journalEntries.status, 'POSTED')),
        )
        .returning({ id: journalEntries.id });

      await this.audit.record(
        {
          action: 'PERIOD_CLOSE',
          module: MODULE,
          entityType: 'FiscalPeriod',
          entityId: period.id,
          previousValue: { status: period.status },
          newValue: { status: 'CLOSED' },
          metadata: { period: period.name, lockedEntries: locked.length, reason },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'period.closed',
        companyId,
        dedupeKey: 'period.closed:' + period.id + ':' + Date.now(),
        payload: {
          fiscalPeriodId: period.id,
          name: period.name,
          startDate: period.startDate,
          endDate: period.endDate,
          status: 'CLOSED',
          lockedEntries: locked.length,
        },
      });
      return closed;
    });
  }

  async reopenPeriod(
    companyId: string,
    periodId: string,
    actorId: string,
    reason?: string,
  ): Promise<FiscalPeriod> {
    return this.db.transaction(async (tx) => {
      const period = await this.lockPeriodRow(companyId, periodId, tx);
      if (period.status === 'LOCKED')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNTING_PERIOD_LOCKED,
          `${period.name} is locked and can never be reopened.`,
        );
      if (period.status === 'OPEN')
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          `${period.name} is not closed.`,
        );
      if (!reason?.trim())
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Reopening a period requires a reason.',
        );
      const year = await this.getYearOrThrow(companyId, period.fiscalYearId, tx);
      if (year.status === 'CLOSED') {
        throw new BusinessRuleError(
          ErrorCodes.FISCAL_YEAR_CLOSED,
          `${year.name} is closed; periods of a closed year cannot be reopened.`,
        );
      }
      const [laterClosed] = await tx
        .select({ name: fiscalPeriods.name })
        .from(fiscalPeriods)
        .where(
          and(
            eq(fiscalPeriods.fiscalYearId, year.id),
            sql`${fiscalPeriods.periodNumber} > ${period.periodNumber}`,
            inArray(fiscalPeriods.status, ['CLOSED', 'LOCKED']),
          ),
        )
        .orderBy(desc(fiscalPeriods.periodNumber))
        .limit(1);
      if (laterClosed) {
        throw new BusinessRuleError(
          ErrorCodes.PERIOD_SEQUENCE_VIOLATION,
          `Reopen ${laterClosed.name} before ${period.name}.`,
        );
      }

      const [reopened] = await tx
        .update(fiscalPeriods)
        .set({ status: 'OPEN', reopenedAt: new Date(), reopenedBy: actorId, reopenReason: reason })
        .where(eq(fiscalPeriods.id, period.id))
        .returning();
      if (!reopened) throw new Error('Update returned no row');

      await tx
        .update(journalEntries)
        .set({ status: 'POSTED' })
        .where(
          and(eq(journalEntries.fiscalPeriodId, period.id), eq(journalEntries.status, 'LOCKED')),
        );

      await this.audit.record(
        {
          action: 'PERIOD_REOPEN',
          module: MODULE,
          entityType: 'FiscalPeriod',
          entityId: period.id,
          previousValue: { status: period.status },
          newValue: { status: 'OPEN' },
          metadata: { period: period.name, reason },
          companyId,
        },
        tx,
      );
      return reopened;
    });
  }

  /**
   * Soft close: the books are provisionally shut. Only holders of
   * `period.post-soft-closed` may still post (late adjustments); everyone else
   * is refused by the posting gateway.
   */
  async softClosePeriod(
    companyId: string,
    periodId: string,
    actorId: string,
    reason?: string,
  ): Promise<FiscalPeriod> {
    return this.db.transaction(async (tx) => {
      const period = await this.lockPeriodRow(companyId, periodId, tx);
      if (period.status !== 'OPEN')
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          `${period.name} is ${period.status.toLowerCase().replace('_', '-')}; only open periods can be soft-closed.`,
        );
      const [updated] = await tx
        .update(fiscalPeriods)
        .set({ status: 'SOFT_CLOSED', closedAt: new Date(), closedBy: actorId })
        .where(eq(fiscalPeriods.id, period.id))
        .returning();
      await this.audit.record(
        {
          action: 'PERIOD_SOFT_CLOSE',
          module: MODULE,
          entityType: 'FiscalPeriod',
          entityId: period.id,
          previousValue: { status: 'OPEN' },
          newValue: { status: 'SOFT_CLOSED' },
          metadata: { period: period.name, reason },
          companyId,
        },
        tx,
      );
      return updated!;
    });
  }

  /**
   * Lock: final state of a closed period. Nothing can be posted into it and it
   * can never be reopened; the database trigger enforces the same rule for
   * any client. Reserved for periods whose statements have been issued.
   */
  async lockPeriod(
    companyId: string,
    periodId: string,
    actorId: string,
    reason?: string,
  ): Promise<FiscalPeriod> {
    return this.db.transaction(async (tx) => {
      const period = await this.lockPeriodRow(companyId, periodId, tx);
      if (period.status === 'LOCKED')
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          `${period.name} is already locked.`,
        );
      if (period.status !== 'CLOSED')
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          `${period.name} must be closed before it can be locked.`,
        );
      const [updated] = await tx
        .update(fiscalPeriods)
        .set({ status: 'LOCKED', lockedAt: new Date(), lockedBy: actorId })
        .where(eq(fiscalPeriods.id, period.id))
        .returning();
      await this.audit.record(
        {
          action: 'PERIOD_LOCK',
          module: MODULE,
          entityType: 'FiscalPeriod',
          entityId: period.id,
          previousValue: { status: 'CLOSED' },
          newValue: { status: 'LOCKED' },
          metadata: { period: period.name, reason },
          companyId,
        },
        tx,
      );
      return updated!;
    });
  }

  /**
   * Year-end close: every period must be closed; the net result of all
   * income-statement accounts is transferred to retained earnings through a
   * CLOSING journal dated on the last day of the year.
   */
  async closeYear(
    companyId: string,
    yearId: string,
    actor: AuthenticatedUser,
  ): Promise<FiscalYearWithPeriods> {
    const actorId = actor.id;
    return this.db.transaction(async (tx) => {
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(and(eq(fiscalYears.id, yearId), eq(fiscalYears.companyId, companyId)))
        .for('update');
      if (!year) throw new NotFoundError('Fiscal year', yearId);
      if (year.status === 'CLOSED')
        throw new BusinessRuleError(
          ErrorCodes.FISCAL_YEAR_CLOSED,
          `${year.name} is already closed.`,
        );

      const periods = await tx
        .select()
        .from(fiscalPeriods)
        .where(eq(fiscalPeriods.fiscalYearId, year.id))
        .orderBy(asc(fiscalPeriods.periodNumber));
      const open = periods.filter((p) => p.status === 'OPEN');
      if (open.length > 0) {
        throw new BusinessRuleError(
          ErrorCodes.PERIOD_SEQUENCE_VIOLATION,
          `Close all periods first (${open.map((p) => p.name).join(', ')}).`,
        );
      }

      const retainedEarnings = await this.accountsService.resolveMapped(
        companyId,
        'RETAINED_EARNINGS',
        tx,
      );
      const currency = await this.accountsService.companyCurrency(companyId, tx);

      // Net balance (debit - credit) of every P&L account for the year.
      const balances = await tx
        .select({
          accountId: journalLines.accountId,
          net: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(
          and(
            eq(journalEntries.companyId, companyId),
            inArray(
              journalEntries.fiscalPeriodId,
              periods.map((p) => p.id),
            ),
            inArray(journalEntries.status, [...LEDGER_STATUSES]),
            inArray(accounts.type, [...INCOME_STATEMENT_TYPES]),
          ),
        )
        .groupBy(journalLines.accountId);

      let closingEntryId: string | null = null;
      const lines = balances
        .map((b) => ({ accountId: b.accountId, net: Money.of(b.net, currency) }))
        .filter((b) => !b.net.isZero())
        .map((b) => ({
          accountId: b.accountId,
          description: `Close ${year.name}`,
          // Reverse the account's net balance so it starts the new year at zero.
          debit: b.net.isNegative() ? b.net.abs().toString() : '0',
          credit: b.net.isPositive() ? b.net.toString() : '0',
        }));
      if (lines.length > 0) {
        const netDebit = Money.sum(
          lines.map((l) => Money.of(l.debit, currency)),
          currency,
        );
        const netCredit = Money.sum(
          lines.map((l) => Money.of(l.credit, currency)),
          currency,
        );
        // Debits so far = closed revenue, credits = closed expenses; the balancing
        // amount goes to retained earnings (credit when the year made a profit).
        const toRetained = netDebit.subtract(netCredit);
        lines.push({
          accountId: retainedEarnings.id,
          description: `Net result ${year.name} to retained earnings`,
          debit: toRetained.isNegative() ? toRetained.abs().toString() : '0',
          credit: toRetained.isPositive() ? toRetained.toString() : '0',
        });
        const entry = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: year.endDate,
            description: `Year-end closing ${year.name}`,
            journalType: 'CLOSING',
            lines: lines.filter((l) => l.debit !== '0' || l.credit !== '0'),
            sourceType: 'FISCAL_YEAR_CLOSE',
            sourceId: year.id,
            actor,
          },
          { allowClosedPeriod: true, permission: P['period.close'] },
        );
        closingEntryId = entry.id;
        await tx
          .update(journalEntries)
          .set({ status: 'LOCKED' })
          .where(eq(journalEntries.id, entry.id));
      }

      const [closed] = await tx
        .update(fiscalYears)
        .set({ status: 'CLOSED', closedAt: new Date(), closedBy: actorId })
        .where(eq(fiscalYears.id, year.id))
        .returning();
      if (!closed) throw new Error('Update returned no row');

      await this.audit.record(
        {
          action: 'YEAR_CLOSE',
          module: MODULE,
          entityType: 'FiscalYear',
          entityId: year.id,
          previousValue: { status: 'OPEN' },
          newValue: { status: 'CLOSED' },
          metadata: { closingEntryId, plAccounts: lines.length },
          companyId,
        },
        tx,
      );
      return { ...closed, periods };
    });
  }

  private async lockPeriodRow(
    companyId: string,
    periodId: string,
    tx: DbExecutor,
  ): Promise<FiscalPeriod> {
    const [row] = await tx
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Fiscal period', periodId);
    return row;
  }
}
