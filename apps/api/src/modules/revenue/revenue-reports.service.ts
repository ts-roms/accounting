import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type {
  RevenueBacklogQuery,
  RevenueRollforwardQuery,
  RevenueWaterfallQuery,
} from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  customers,
  invoices,
  journalEntries,
  revenueRecognitionRuns,
  revenueScheduleLines,
  revenueSchedules,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type {
  IntegrityFinding,
  IntegrityReport,
} from '@/modules/accounting/integrity/integrity.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { businessToday } from '@/common/time/clock';
import { RevenueConfigService } from './revenue-config.service';
import { addDays, waterfall, type OpenLine } from './revenue.logic';

export interface RevenueRollforward {
  from: string;
  to: string;
  currency: string;
  opening: string;
  additions: string;
  recognized: string;
  voided: string;
  closing: string;
  /** Credit balance of the DEFERRED_REVENUE account at `to` (null when unmapped). */
  ledgerBalance: string | null;
  difference: string | null;
  byMethod: Array<{
    method: string;
    opening: string;
    additions: string;
    recognized: string;
    voided: string;
    closing: string;
  }>;
}

export interface RevenueWaterfall {
  from: string;
  months: number;
  currency: string;
  buckets: Array<{ month: string; amount: string }>;
  unscheduled: string;
  beyond: string;
  total: string;
  byCustomer: Array<{
    customerId: string;
    customerCode: string;
    customerName: string;
    buckets: string[];
    unscheduled: string;
    beyond: string;
    total: string;
  }>;
}

export interface RevenueBacklogRow {
  customerId: string;
  customerCode: string;
  customerName: string;
  schedules: number;
  deferred: string;
  dueWithin30Days: string;
  overdue: string;
  unscheduled: string;
}

export interface RevenueBacklog {
  asOf: string;
  currency: string;
  totals: Omit<RevenueBacklogRow, 'customerId' | 'customerCode' | 'customerName'>;
  rows: RevenueBacklogRow[];
}

/**
 * Deferred revenue reporting (Prompt #10). Every figure is derived from the
 * schedule lines; the rollforward proves them against the ledger's deferred
 * revenue balance (which the integrity report checks the same way).
 */
@Injectable()
export class RevenueReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
    private readonly config: RevenueConfigService,
  ) {}

  /** Opening + additions (invoice posted in window) - recognized (run period end in window) - voided = closing. */
  async rollforward(
    companyId: string,
    query: RevenueRollforwardQuery,
  ): Promise<RevenueRollforward> {
    const currency = await this.accounts.companyCurrency(companyId);
    const schedules = await this.db
      .select({
        id: revenueSchedules.id,
        method: revenueSchedules.method,
        totalAmount: revenueSchedules.totalAmount,
        status: revenueSchedules.status,
        cancelledAt: revenueSchedules.cancelledAt,
        documentDate: invoices.documentDate,
        // A voided invoice's reversal carries the date the deferral left the ledger.
        voidDate: journalEntries.entryDate,
      })
      .from(revenueSchedules)
      .innerJoin(invoices, eq(invoices.id, revenueSchedules.invoiceId))
      .leftJoin(journalEntries, eq(journalEntries.id, invoices.reversalJournalEntryId))
      .where(and(eq(revenueSchedules.companyId, companyId), lte(invoices.documentDate, query.to)));
    const recognizedLines = await this.db
      .select({
        scheduleId: revenueScheduleLines.scheduleId,
        amount: revenueScheduleLines.amount,
        periodEnd: revenueRecognitionRuns.periodEnd,
      })
      .from(revenueScheduleLines)
      .innerJoin(revenueRecognitionRuns, eq(revenueRecognitionRuns.id, revenueScheduleLines.runId))
      .innerJoin(revenueSchedules, eq(revenueSchedules.id, revenueScheduleLines.scheduleId))
      .where(
        and(
          eq(revenueSchedules.companyId, companyId),
          eq(revenueScheduleLines.status, 'RECOGNIZED'),
          lte(revenueRecognitionRuns.periodEnd, query.to),
        ),
      );
    type Bucket = { opening: Money; additions: Money; recognized: Money; voided: Money };
    const zero = (): Bucket => ({
      opening: Money.zero(currency),
      additions: Money.zero(currency),
      recognized: Money.zero(currency),
      voided: Money.zero(currency),
    });
    const byMethod = new Map<string, Bucket>();
    const bucket = (method: string) => {
      let b = byMethod.get(method);
      if (!b) byMethod.set(method, (b = zero()));
      return b;
    };
    const methodOf = new Map(schedules.map((s) => [s.id, s.method]));
    for (const s of schedules) {
      const amount = Money.of(s.totalAmount, currency);
      const b = bucket(s.method);
      if (s.documentDate < query.from) b.opening = b.opening.add(amount);
      else b.additions = b.additions.add(amount);
      if (s.status === 'CANCELLED') {
        const voidDate = s.voidDate ?? s.cancelledAt?.toISOString().slice(0, 10) ?? s.documentDate;
        if (voidDate < query.from) b.opening = b.opening.subtract(amount);
        else if (voidDate <= query.to) b.voided = b.voided.add(amount);
      }
    }
    for (const l of recognizedLines) {
      const method = methodOf.get(l.scheduleId);
      if (!method) continue;
      const b = bucket(method);
      const amount = Money.of(l.amount, currency);
      if (l.periodEnd < query.from) b.opening = b.opening.subtract(amount);
      else b.recognized = b.recognized.add(amount);
    }
    const total = zero();
    const rows = [...byMethod.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([method, b]) => {
        total.opening = total.opening.add(b.opening);
        total.additions = total.additions.add(b.additions);
        total.recognized = total.recognized.add(b.recognized);
        total.voided = total.voided.add(b.voided);
        return {
          method,
          opening: b.opening.toString(),
          additions: b.additions.toString(),
          recognized: b.recognized.toString(),
          voided: b.voided.toString(),
          closing: b.opening.add(b.additions).subtract(b.recognized).subtract(b.voided).toString(),
        };
      });
    const closing = total.opening
      .add(total.additions)
      .subtract(total.recognized)
      .subtract(total.voided);
    const ledgerBalance = await this.deferredLedgerBalance(companyId, query.to, currency);
    return {
      from: query.from,
      to: query.to,
      currency,
      opening: total.opening.toString(),
      additions: total.additions.toString(),
      recognized: total.recognized.toString(),
      voided: total.voided.toString(),
      closing: closing.toString(),
      ledgerBalance: ledgerBalance?.toString() ?? null,
      difference: ledgerBalance ? ledgerBalance.subtract(closing).toString() : null,
      byMethod: rows,
    };
  }

  async waterfall(companyId: string, query: RevenueWaterfallQuery): Promise<RevenueWaterfall> {
    const currency = await this.accounts.companyCurrency(companyId);
    const from = query.from ?? businessToday();
    const rows = await this.openLines(companyId);
    const overall = waterfall(rows, currency, from, query.months);
    const byCustomer = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byCustomer.get(r.customerId) ?? [];
      list.push(r);
      byCustomer.set(r.customerId, list);
    }
    return {
      from,
      months: query.months,
      currency,
      buckets: overall.buckets,
      unscheduled: overall.unscheduled,
      beyond: overall.beyond,
      total: overall.total,
      byCustomer: [...byCustomer.values()]
        .map((lines) => {
          const w = waterfall(lines, currency, from, query.months);
          const first = lines[0]!;
          return {
            customerId: first.customerId,
            customerCode: first.customerCode,
            customerName: first.customerName,
            buckets: w.buckets.map((b) => b.amount),
            unscheduled: w.unscheduled,
            beyond: w.beyond,
            total: w.total,
          };
        })
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  }

  async backlog(companyId: string, query: RevenueBacklogQuery): Promise<RevenueBacklog> {
    const currency = await this.accounts.companyCurrency(companyId);
    const asOf = query.asOf ?? businessToday();
    const horizon = addDays(asOf, 30);
    const rows = await this.openLines(companyId);
    const byCustomer = new Map<string, RevenueBacklogRow & { scheduleIds: Set<string> }>();
    const totals = {
      schedules: new Set<string>(),
      deferred: Money.zero(currency),
      dueWithin30Days: Money.zero(currency),
      overdue: Money.zero(currency),
      unscheduled: Money.zero(currency),
    };
    for (const r of rows) {
      if (r.status !== 'PENDING') continue;
      let row = byCustomer.get(r.customerId);
      if (!row) {
        row = {
          customerId: r.customerId,
          customerCode: r.customerCode,
          customerName: r.customerName,
          schedules: 0,
          deferred: '0',
          dueWithin30Days: '0',
          overdue: '0',
          unscheduled: '0',
          scheduleIds: new Set(),
        };
        byCustomer.set(r.customerId, row);
      }
      const amount = Money.of(r.amount, currency);
      row.scheduleIds.add(r.scheduleId);
      totals.schedules.add(r.scheduleId);
      row.deferred = amount.add(Money.of(row.deferred, currency)).toString();
      totals.deferred = totals.deferred.add(amount);
      const due = r.recognitionDate && (r.method !== 'MILESTONE' || r.completed);
      if (!r.recognitionDate) {
        row.unscheduled = amount.add(Money.of(row.unscheduled, currency)).toString();
        totals.unscheduled = totals.unscheduled.add(amount);
      } else if (due && r.recognitionDate <= asOf) {
        row.overdue = amount.add(Money.of(row.overdue, currency)).toString();
        totals.overdue = totals.overdue.add(amount);
      } else if (r.recognitionDate <= horizon) {
        row.dueWithin30Days = amount.add(Money.of(row.dueWithin30Days, currency)).toString();
        totals.dueWithin30Days = totals.dueWithin30Days.add(amount);
      }
    }
    return {
      asOf,
      currency,
      totals: {
        schedules: totals.schedules.size,
        deferred: totals.deferred.toString(),
        dueWithin30Days: totals.dueWithin30Days.toString(),
        overdue: totals.overdue.toString(),
        unscheduled: totals.unscheduled.toString(),
      },
      rows: [...byCustomer.values()]
        .map(({ scheduleIds, ...row }) => ({ ...row, schedules: scheduleIds.size }))
        .sort((a, b) => Number(b.deferred) - Number(a.deferred)),
    };
  }

  // ---------------------------------------------------------------- integrity

  async integrity(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.deferredVsLedger(companyId, asOf, currency),
      this.scheduleTotals(companyId, currency),
      this.recognizedWithoutJournal(companyId),
      this.overdueRecognition(companyId, asOf, currency),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  /** The DEFERRED_REVENUE credit balance must equal the pending schedule lines (as of the run dates). */
  private async deferredVsLedger(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const ledger = await this.deferredLedgerBalance(companyId, asOf, currency);
    if (!ledger)
      return finding(
        'DEFERRED_REVENUE_VS_LEDGER',
        'CRITICAL',
        'Deferred revenue equals the open schedule lines',
        0,
        [],
        'No DEFERRED_REVENUE mapping yet.',
      );
    // Schedule view at `asOf`: invoices posted by then, less lines recognized by runs dated by then.
    const rf = await this.rollforward(companyId, { from: '1900-01-01', to: asOf });
    const expected = Money.of(rf.closing, currency);
    const variance = ledger.subtract(expected);
    return finding(
      'DEFERRED_REVENUE_VS_LEDGER',
      'CRITICAL',
      'Deferred revenue equals the open schedule lines',
      variance.isZero() ? 0 : 1,
      variance.isZero()
        ? []
        : [
            {
              ledger: ledger.toString(),
              schedules: expected.toString(),
              variance: variance.toString(),
            },
          ],
    );
  }

  /** Each schedule's lines sum to its total and its recognized amount matches its RECOGNIZED lines. */
  private async scheduleTotals(companyId: string, currency: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: revenueSchedules.id,
        description: revenueSchedules.description,
        totalAmount: revenueSchedules.totalAmount,
        recognizedAmount: revenueSchedules.recognizedAmount,
        status: revenueSchedules.status,
        lineTotal: sql<string>`coalesce(sum(case when ${revenueScheduleLines.status} <> 'CANCELLED' then ${revenueScheduleLines.amount} else 0 end), 0)`,
        recognized: sql<string>`coalesce(sum(case when ${revenueScheduleLines.status} = 'RECOGNIZED' then ${revenueScheduleLines.amount} else 0 end), 0)`,
      })
      .from(revenueSchedules)
      .leftJoin(revenueScheduleLines, eq(revenueScheduleLines.scheduleId, revenueSchedules.id))
      .where(eq(revenueSchedules.companyId, companyId))
      .groupBy(revenueSchedules.id);
    const bad = rows.filter((r) => {
      const linesOk =
        r.status === 'CANCELLED' ||
        Money.of(r.lineTotal, currency).equals(Money.of(r.totalAmount, currency));
      const recognizedOk = Money.of(r.recognized, currency).equals(
        Money.of(r.recognizedAmount, currency),
      );
      return !(linesOk && recognizedOk);
    });
    return finding(
      'SCHEDULE_TOTALS',
      'CRITICAL',
      'Schedule lines sum to the schedule and recognized amounts agree',
      bad.length,
      bad.map((r) => ({
        scheduleId: r.id,
        description: r.description,
        total: r.totalAmount,
        lines: r.lineTotal,
        recognized: r.recognizedAmount,
        recognizedLines: r.recognized,
      })),
    );
  }

  /** Recognized lines always point at a run with a posted journal. */
  private async recognizedWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ id: revenueScheduleLines.id, description: revenueSchedules.description })
      .from(revenueScheduleLines)
      .innerJoin(revenueSchedules, eq(revenueSchedules.id, revenueScheduleLines.scheduleId))
      .leftJoin(revenueRecognitionRuns, eq(revenueRecognitionRuns.id, revenueScheduleLines.runId))
      .where(
        and(
          eq(revenueSchedules.companyId, companyId),
          eq(revenueScheduleLines.status, 'RECOGNIZED'),
          sql`(${revenueScheduleLines.journalEntryId} is null or ${revenueRecognitionRuns.id} is null or ${revenueRecognitionRuns.status} <> 'POSTED')`,
        ),
      );
    return finding(
      'RECOGNIZED_WITHOUT_JOURNAL',
      'CRITICAL',
      'Recognized schedule lines carry a posted run journal',
      rows.length,
      rows.map((r) => ({ lineId: r.id, description: r.description })),
    );
  }

  /** Lines due before `asOf` minus the grace period that no run has recognized. */
  private async overdueRecognition(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const settings = await this.config.settings(companyId);
    const cutoff = addDays(asOf, -settings.overdueGraceDays);
    const rows = await this.db
      .select({
        id: revenueScheduleLines.id,
        description: revenueSchedules.description,
        recognitionDate: revenueScheduleLines.recognitionDate,
        amount: revenueScheduleLines.amount,
      })
      .from(revenueScheduleLines)
      .innerJoin(revenueSchedules, eq(revenueSchedules.id, revenueScheduleLines.scheduleId))
      .where(
        and(
          eq(revenueSchedules.companyId, companyId),
          eq(revenueSchedules.status, 'ACTIVE'),
          eq(revenueScheduleLines.status, 'PENDING'),
          lt(revenueScheduleLines.recognitionDate, cutoff),
          sql`(${revenueSchedules.method} <> 'MILESTONE' or ${revenueScheduleLines.completedAt} is not null)`,
        ),
      )
      .orderBy(asc(revenueScheduleLines.recognitionDate));
    const total = Money.sum(
      rows.map((r) => Money.of(r.amount, currency)),
      currency,
    );
    return finding(
      'OVERDUE_RECOGNITION',
      'WARNING',
      'No recognition line is overdue',
      rows.length,
      rows.map((r) => ({
        lineId: r.id,
        description: r.description,
        recognitionDate: r.recognitionDate,
        amount: r.amount,
      })),
      rows.length
        ? `${currency} ${total.toString()} due before ${cutoff} and not yet recognized.`
        : undefined,
    );
  }

  // ---------------------------------------------------------------- internals

  private async openLines(companyId: string) {
    return this.db
      .select({
        scheduleId: revenueSchedules.id,
        customerId: revenueSchedules.customerId,
        customerCode: customers.code,
        customerName: customers.name,
        method: revenueSchedules.method,
        recognitionDate: revenueScheduleLines.recognitionDate,
        amount: revenueScheduleLines.amount,
        status: revenueScheduleLines.status,
        completedAt: revenueScheduleLines.completedAt,
      })
      .from(revenueScheduleLines)
      .innerJoin(revenueSchedules, eq(revenueSchedules.id, revenueScheduleLines.scheduleId))
      .innerJoin(customers, eq(customers.id, revenueSchedules.customerId))
      .where(
        and(
          eq(revenueSchedules.companyId, companyId),
          eq(revenueSchedules.status, 'ACTIVE'),
          eq(revenueScheduleLines.status, 'PENDING'),
        ),
      )
      .then((rows) =>
        rows.map(
          (
            r,
          ): OpenLine & {
            scheduleId: string;
            customerId: string;
            customerCode: string;
            customerName: string;
          } => ({
            ...r,
            completed: r.completedAt !== null,
          }),
        ),
      );
  }

  /** Credit balance of the mapped deferred revenue account at `asOf`, null when unmapped. */
  private async deferredLedgerBalance(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<Money | null> {
    const [mapping] = await this.db
      .select({ accountId: accountMappings.accountId })
      .from(accountMappings)
      .where(
        and(eq(accountMappings.companyId, companyId), eq(accountMappings.key, 'DEFERRED_REVENUE')),
      );
    if (!mapping) return null;
    const activity = await this.ledger.activity({
      companyId,
      to: asOf,
      accountIds: [mapping.accountId],
    });
    const row = activity.find((a) => a.accountId === mapping.accountId);
    if (!row) return Money.zero(currency);
    return Money.of(row.credit, currency).subtract(Money.of(row.debit, currency));
  }
}

function finding(
  check: string,
  severity: IntegrityFinding['severity'],
  title: string,
  count: number,
  samples: Array<Record<string, unknown>>,
  detail?: string,
): IntegrityFinding {
  return { check, severity, title, count, samples: samples.slice(0, 20), detail };
}
