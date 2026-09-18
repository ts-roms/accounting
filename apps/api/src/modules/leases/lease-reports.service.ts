import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { LeaseClassification, LeaseStatus } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  leaseEvents,
  leaseScheduleLines,
  leases,
  vendors,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type {
  IntegrityFinding,
  IntegrityReport,
} from '@/modules/accounting/integrity/integrity.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { addMonths, maturityBuckets } from './lease.logic';

export interface LeaseRegisterRow {
  leaseId: string;
  leaseNumber: string;
  name: string;
  vendorName: string | null;
  classification: LeaseClassification;
  status: LeaseStatus;
  commencementDate: string;
  endDate: string;
  termMonths: number;
  paymentAmount: string;
  paymentFrequency: string;
  annualDiscountRate: string | null;
  initialLiability: string;
  liabilityBalance: string;
  rouCost: string;
  rouAccumulatedDepreciation: string;
  rouCarrying: string;
  remainingMonths: number;
  remainingPayments: string;
  nextPaymentDate: string | null;
}

export interface LeaseRegister {
  asOf: string;
  currency: string;
  rows: LeaseRegisterRow[];
  totals: {
    leases: number;
    finance: number;
    exempt: number;
    liability: string;
    rouCost: string;
    rouAccumulatedDepreciation: string;
    rouCarrying: string;
    remainingPayments: string;
  };
}

export interface LeaseMaturity {
  asOf: string;
  currency: string;
  buckets: Array<{ label: string; from: string; to: string; amount: string }>;
  undiscountedTotal: string;
  liability: string;
  /** Principal falling due within twelve months of `asOf` (schedule based). */
  currentPortion: string;
  nonCurrentPortion: string;
  /** Undiscounted payments less the liability. */
  unaccruedInterest: string;
  byLease: Array<{
    leaseId: string;
    leaseNumber: string;
    name: string;
    liability: string;
    currentPortion: string;
    nonCurrentPortion: string;
    remainingPayments: string;
  }>;
}

export interface LeaseDashboard {
  asOf: string;
  currency: string;
  activeLeases: number;
  draftLeases: number;
  liability: string;
  rouCarrying: string;
  monthsAwaitingRun: number;
  overduePayments: number;
  overduePaymentAmount: string;
  next30DaysPayments: string;
  integrity: IntegrityReport;
}

/**
 * Lease reports (Prompt #13) read the register and the schedule; ledger
 * figures come only from `GeneralLedgerService.activity`. Nothing is stored.
 */
@Injectable()
export class LeaseReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
  ) {}

  async register(companyId: string, asOf: string): Promise<LeaseRegister> {
    const currency = await this.accounts.companyCurrency(companyId);
    const rows = await this.db
      .select({ lease: leases, vendorName: vendors.name })
      .from(leases)
      .leftJoin(vendors, eq(vendors.id, leases.vendorId))
      .where(and(eq(leases.companyId, companyId), ne(leases.status, 'DRAFT')))
      .orderBy(asc(leases.leaseNumber));
    const lines = rows.length
      ? await this.db
          .select()
          .from(leaseScheduleLines)
          .where(
            and(
              inArray(
                leaseScheduleLines.leaseId,
                rows.map((r) => r.lease.id),
              ),
              ne(leaseScheduleLines.status, 'CANCELLED'),
            ),
          )
          .orderBy(asc(leaseScheduleLines.sequence))
      : [];
    const out: LeaseRegisterRow[] = rows.map(({ lease, vendorName }) => {
      const mine = lines.filter((l) => l.leaseId === lease.id);
      const unpaid = mine.filter((l) => !l.paidAt && !Money.of(l.payment, currency).isZero());
      return {
        leaseId: lease.id,
        leaseNumber: lease.leaseNumber,
        name: lease.name,
        vendorName: vendorName ?? null,
        classification: lease.classification,
        status: lease.status,
        commencementDate: lease.commencementDate,
        endDate: addMonthsMinusDay(lease.commencementDate, lease.termMonths),
        termMonths: lease.termMonths,
        paymentAmount: lease.paymentAmount,
        paymentFrequency: lease.paymentFrequency,
        annualDiscountRate: lease.annualDiscountRate,
        initialLiability: lease.initialLiability,
        liabilityBalance: lease.liabilityBalance,
        rouCost: lease.rouCost,
        rouAccumulatedDepreciation: lease.rouAccumulatedDepreciation,
        rouCarrying: Money.of(lease.rouCost, currency)
          .subtract(Money.of(lease.rouAccumulatedDepreciation, currency))
          .toString(),
        remainingMonths: mine.filter((l) => l.status === 'PENDING').length,
        remainingPayments: Money.sum(
          unpaid.map((l) => Money.of(l.payment, currency)),
          currency,
        ).toString(),
        nextPaymentDate: unpaid[0]?.paymentDate ?? null,
      };
    });
    const active = out.filter((r) => r.status === 'ACTIVE');
    const sum = (pick: (r: LeaseRegisterRow) => string) =>
      Money.sum(
        active.map((r) => Money.of(pick(r), currency)),
        currency,
      ).toString();
    return {
      asOf,
      currency,
      rows: out,
      totals: {
        leases: out.length,
        finance: active.filter((r) => r.classification === 'FINANCE').length,
        exempt: active.filter((r) => r.classification !== 'FINANCE').length,
        liability: sum((r) => r.liabilityBalance),
        rouCost: sum((r) => r.rouCost),
        rouAccumulatedDepreciation: sum((r) => r.rouAccumulatedDepreciation),
        rouCarrying: sum((r) => r.rouCarrying),
        remainingPayments: sum((r) => r.remainingPayments),
      },
    };
  }

  async maturity(companyId: string, asOf: string, years = 4): Promise<LeaseMaturity> {
    const currency = await this.accounts.companyCurrency(companyId);
    const active = await this.db
      .select()
      .from(leases)
      .where(and(eq(leases.companyId, companyId), eq(leases.status, 'ACTIVE')))
      .orderBy(asc(leases.leaseNumber));
    const lines = active.length
      ? await this.db
          .select()
          .from(leaseScheduleLines)
          .where(
            and(
              inArray(
                leaseScheduleLines.leaseId,
                active.map((l) => l.id),
              ),
              ne(leaseScheduleLines.status, 'CANCELLED'),
            ),
          )
          .orderBy(asc(leaseScheduleLines.sequence))
      : [];
    const horizon = addMonthsMinusDay(asOf, 12);
    const byLease = active.map((lease) => {
      const mine = lines.filter((l) => l.leaseId === lease.id);
      const liability = Money.of(lease.liabilityBalance, currency);
      // Schedule view: the liability one year out is the closing balance of the last month ending by then.
      const within = mine.filter((l) => l.periodEnd <= horizon && l.status !== 'CANCELLED');
      const lastWithin = within[within.length - 1];
      const beyond = mine.some((l) => l.periodEnd > horizon && l.status === 'PENDING');
      const nonCurrent =
        lease.classification !== 'FINANCE' || !beyond
          ? Money.zero(currency)
          : Money.of(lastWithin?.closingLiability ?? lease.liabilityBalance, currency);
      const bounded = nonCurrent.greaterThan(liability) ? liability : nonCurrent;
      const remaining = Money.sum(
        mine.filter((l) => !l.paidAt).map((l) => Money.of(l.payment, currency)),
        currency,
      );
      return {
        leaseId: lease.id,
        leaseNumber: lease.leaseNumber,
        name: lease.name,
        liability,
        currentPortion: liability.subtract(bounded),
        nonCurrentPortion: bounded,
        remainingPayments: remaining,
      };
    });
    const buckets = maturityBuckets(
      lines.map((l) => ({
        payment: l.payment,
        paymentDate: l.paymentDate,
        paid: Boolean(l.paidAt),
      })),
      asOf,
      years,
      currency,
    );
    const undiscounted = Money.sum(
      buckets.map((b) => Money.of(b.amount, currency)),
      currency,
    );
    const liability = Money.sum(
      byLease.map((l) => l.liability),
      currency,
    );
    return {
      asOf,
      currency,
      buckets,
      undiscountedTotal: undiscounted.toString(),
      liability: liability.toString(),
      currentPortion: Money.sum(
        byLease.map((l) => l.currentPortion),
        currency,
      ).toString(),
      nonCurrentPortion: Money.sum(
        byLease.map((l) => l.nonCurrentPortion),
        currency,
      ).toString(),
      unaccruedInterest: undiscounted.subtract(liability).toString(),
      byLease: byLease.map((l) => ({
        ...l,
        liability: l.liability.toString(),
        currentPortion: l.currentPortion.toString(),
        nonCurrentPortion: l.nonCurrentPortion.toString(),
        remainingPayments: l.remainingPayments.toString(),
      })),
    };
  }

  async dashboard(companyId: string, asOf: string): Promise<LeaseDashboard> {
    const currency = await this.accounts.companyCurrency(companyId);
    const [counts] = await this.db
      .select({
        active: sql<number>`count(*) filter (where ${leases.status} = 'ACTIVE')::int`,
        draft: sql<number>`count(*) filter (where ${leases.status} = 'DRAFT')::int`,
        liability: sql<string>`coalesce(sum(${leases.liabilityBalance}) filter (where ${leases.status} = 'ACTIVE'), 0)`,
        carrying: sql<string>`coalesce(sum(${leases.rouCost} - ${leases.rouAccumulatedDepreciation}) filter (where ${leases.status} = 'ACTIVE'), 0)`,
      })
      .from(leases)
      .where(eq(leases.companyId, companyId));
    const [months] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(leaseScheduleLines)
      .innerJoin(leases, eq(leases.id, leaseScheduleLines.leaseId))
      .where(
        and(
          eq(leases.companyId, companyId),
          eq(leases.status, 'ACTIVE'),
          eq(leases.classification, 'FINANCE'),
          eq(leaseScheduleLines.status, 'PENDING'),
          lte(leaseScheduleLines.periodEnd, asOf),
        ),
      );
    const unpaid = await this.db
      .select({ payment: leaseScheduleLines.payment, paymentDate: leaseScheduleLines.paymentDate })
      .from(leaseScheduleLines)
      .innerJoin(leases, eq(leases.id, leaseScheduleLines.leaseId))
      .where(
        and(
          eq(leases.companyId, companyId),
          eq(leases.status, 'ACTIVE'),
          ne(leaseScheduleLines.status, 'CANCELLED'),
          isNull(leaseScheduleLines.paidAt),
          sql`${leaseScheduleLines.payment} > 0`,
        ),
      );
    const overdue = unpaid.filter((u) => (u.paymentDate ?? '') < asOf);
    const soon = unpaid.filter(
      (u) => (u.paymentDate ?? '') >= asOf && (u.paymentDate ?? '') <= addMonthsMinusDay(asOf, 1),
    );
    return {
      asOf,
      currency,
      activeLeases: counts?.active ?? 0,
      draftLeases: counts?.draft ?? 0,
      liability: Money.of(counts?.liability ?? '0', currency).toString(),
      rouCarrying: Money.of(counts?.carrying ?? '0', currency).toString(),
      monthsAwaitingRun: months?.n ?? 0,
      overduePayments: overdue.length,
      overduePaymentAmount: Money.sum(
        overdue.map((u) => Money.of(u.payment, currency)),
        currency,
      ).toString(),
      next30DaysPayments: Money.sum(
        soon.map((u) => Money.of(u.payment, currency)),
        currency,
      ).toString(),
      integrity: await this.integrity(companyId, asOf),
    };
  }

  // -------------------------------------------------------------- integrity

  async integrity(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.liabilityVsLedger(companyId, asOf, currency),
      this.rouVsLedger(companyId, asOf, currency),
      this.scheduleTotals(companyId, currency),
      this.runsOverdue(companyId, asOf),
      this.paymentsOverdue(companyId, asOf, currency),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  /** The LEASE_LIABILITY credit balance equals the liability the lease events carry as of the date. */
  private async liabilityVsLedger(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const ledger = await this.mappedBalance(companyId, 'LEASE_LIABILITY', asOf, currency, 'CREDIT');
    if (ledger === null)
      return finding(
        'LEASE_LIABILITY_VS_LEDGER',
        'CRITICAL',
        'Lease liability equals the register',
        0,
        [],
        'No LEASE_LIABILITY mapping yet.',
      );
    const [agg] = await this.db
      .select({ total: sql<string>`coalesce(sum(${leaseEvents.liabilityChange}), 0)` })
      .from(leaseEvents)
      .innerJoin(leases, eq(leases.id, leaseEvents.leaseId))
      .where(
        and(
          eq(leaseEvents.companyId, companyId),
          eq(leases.classification, 'FINANCE'),
          lte(leaseEvents.eventDate, asOf),
        ),
      );
    const expected = Money.of(agg?.total ?? '0', currency);
    const variance = ledger.subtract(expected);
    return finding(
      'LEASE_LIABILITY_VS_LEDGER',
      'CRITICAL',
      'Lease liability equals the register',
      variance.isZero() ? 0 : 1,
      variance.isZero()
        ? []
        : [
            {
              ledger: ledger.toString(),
              register: expected.toString(),
              variance: variance.toString(),
            },
          ],
    );
  }

  /** ROU cost less accumulated depreciation in the ledger equals the carrying amount the events carry. */
  private async rouVsLedger(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const cost = await this.mappedBalance(companyId, 'RIGHT_OF_USE_ASSET', asOf, currency, 'DEBIT');
    const accumulated = await this.mappedBalance(
      companyId,
      'ROU_ACCUMULATED_DEPRECIATION',
      asOf,
      currency,
      'CREDIT',
    );
    if (cost === null || accumulated === null)
      return finding(
        'ROU_ASSET_VS_LEDGER',
        'CRITICAL',
        'Right-of-use carrying amount equals the register',
        0,
        [],
        'Right-of-use mappings are not complete yet.',
      );
    const ledger = cost.subtract(accumulated);
    const [agg] = await this.db
      .select({ total: sql<string>`coalesce(sum(${leaseEvents.rouChange}), 0)` })
      .from(leaseEvents)
      .innerJoin(leases, eq(leases.id, leaseEvents.leaseId))
      .where(
        and(
          eq(leaseEvents.companyId, companyId),
          eq(leases.classification, 'FINANCE'),
          lte(leaseEvents.eventDate, asOf),
        ),
      );
    const expected = Money.of(agg?.total ?? '0', currency);
    const variance = ledger.subtract(expected);
    return finding(
      'ROU_ASSET_VS_LEDGER',
      'CRITICAL',
      'Right-of-use carrying amount equals the register',
      variance.isZero() ? 0 : 1,
      variance.isZero()
        ? []
        : [
            {
              ledger: ledger.toString(),
              register: expected.toString(),
              variance: variance.toString(),
            },
          ],
    );
  }

  /**
   * Per active finance lease: the live schedule amortises to zero, its
   * depreciation sums to the ROU cost, and the register liability equals the
   * last posted month's closing balance adjusted for payments made early or
   * late.
   */
  private async scheduleTotals(companyId: string, currency: string): Promise<IntegrityFinding> {
    const active = await this.db
      .select()
      .from(leases)
      .where(
        and(
          eq(leases.companyId, companyId),
          eq(leases.status, 'ACTIVE'),
          eq(leases.classification, 'FINANCE'),
        ),
      );
    const samples: Array<Record<string, unknown>> = [];
    for (const lease of active) {
      const lines = await this.db
        .select()
        .from(leaseScheduleLines)
        .where(
          and(eq(leaseScheduleLines.leaseId, lease.id), ne(leaseScheduleLines.status, 'CANCELLED')),
        )
        .orderBy(asc(leaseScheduleLines.sequence));
      if (lines.length === 0) {
        samples.push({ leaseNumber: lease.leaseNumber, problem: 'no schedule' });
        continue;
      }
      const last = lines[lines.length - 1]!;
      const problems: string[] = [];
      if (!Money.of(last.closingLiability, currency).isZero())
        problems.push(`schedule ends at ${last.closingLiability}`);
      const dep = Money.sum(
        lines.map((l) => Money.of(l.depreciation, currency)),
        currency,
      );
      if (!dep.equals(Money.of(lease.rouCost, currency)))
        problems.push(`depreciation ${dep.toString()} vs cost ${lease.rouCost}`);
      const posted = lines.filter((l) => l.status === 'POSTED');
      const lastPosted = posted[posted.length - 1];
      const firstPending = lines.find((l) => l.status === 'PENDING');
      // The first pending month opens at the liability the schedule expects (a remeasurement rebases it).
      const base = Money.of(
        firstPending?.openingLiability ?? lastPosted?.closingLiability ?? '0',
        currency,
      );
      const unpaidPosted = Money.sum(
        posted.filter((l) => !l.paidAt).map((l) => Money.of(l.payment, currency)),
        currency,
      );
      const paidPending = Money.sum(
        lines
          .filter((l) => l.status === 'PENDING' && l.paidAt)
          .map((l) => Money.of(l.payment, currency)),
        currency,
      );
      const expected = base.add(unpaidPosted).subtract(paidPending);
      if (!expected.equals(Money.of(lease.liabilityBalance, currency)))
        problems.push(`register ${lease.liabilityBalance} vs schedule ${expected.toString()}`);
      if (problems.length)
        samples.push({ leaseNumber: lease.leaseNumber, problems: problems.join('; ') });
    }
    return finding(
      'LEASE_SCHEDULE_TOTALS',
      'CRITICAL',
      'Schedules amortise to zero and agree with the register',
      samples.length,
      samples,
    );
  }

  /** Months of finance leases that ended before the current month and are not posted. */
  private async runsOverdue(companyId: string, asOf: string): Promise<IntegrityFinding> {
    const monthStart = `${asOf.slice(0, 7)}-01`;
    const rows = await this.db
      .select({
        leaseNumber: leases.leaseNumber,
        sequence: leaseScheduleLines.sequence,
        periodEnd: leaseScheduleLines.periodEnd,
      })
      .from(leaseScheduleLines)
      .innerJoin(leases, eq(leases.id, leaseScheduleLines.leaseId))
      .where(
        and(
          eq(leases.companyId, companyId),
          eq(leases.status, 'ACTIVE'),
          eq(leases.classification, 'FINANCE'),
          eq(leaseScheduleLines.status, 'PENDING'),
          sql`${leaseScheduleLines.periodEnd} < ${monthStart}`,
        ),
      )
      .orderBy(asc(leaseScheduleLines.periodEnd));
    return finding(
      'LEASE_RUNS_OVERDUE',
      'WARNING',
      'Every completed month has its lease run',
      rows.length,
      rows,
    );
  }

  private async paymentsOverdue(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        leaseNumber: leases.leaseNumber,
        sequence: leaseScheduleLines.sequence,
        paymentDate: leaseScheduleLines.paymentDate,
        payment: leaseScheduleLines.payment,
      })
      .from(leaseScheduleLines)
      .innerJoin(leases, eq(leases.id, leaseScheduleLines.leaseId))
      .where(
        and(
          eq(leases.companyId, companyId),
          eq(leases.status, 'ACTIVE'),
          ne(leaseScheduleLines.status, 'CANCELLED'),
          isNull(leaseScheduleLines.paidAt),
          sql`${leaseScheduleLines.payment} > 0`,
          sql`${leaseScheduleLines.paymentDate} < ${asOf}`,
        ),
      )
      .orderBy(asc(leaseScheduleLines.paymentDate));
    return finding(
      'LEASE_PAYMENTS_OVERDUE',
      'WARNING',
      'No lease payment is past its date',
      rows.length,
      rows.map((r) => ({ ...r, payment: Money.of(r.payment, currency).toString() })),
    );
  }

  private async mappedBalance(
    companyId: string,
    key: 'LEASE_LIABILITY' | 'RIGHT_OF_USE_ASSET' | 'ROU_ACCUMULATED_DEPRECIATION',
    asOf: string,
    currency: string,
    normal: 'DEBIT' | 'CREDIT',
  ): Promise<Money | null> {
    const [mapping] = await this.db
      .select({ accountId: accountMappings.accountId })
      .from(accountMappings)
      .where(and(eq(accountMappings.companyId, companyId), eq(accountMappings.key, key)));
    if (!mapping) return null;
    const activity = await this.ledger.activity({
      companyId,
      to: asOf,
      accountIds: [mapping.accountId],
    });
    const row = activity.find((a) => a.accountId === mapping.accountId);
    if (!row) return Money.zero(currency);
    const debit = Money.of(row.debit, currency);
    const credit = Money.of(row.credit, currency);
    return normal === 'DEBIT' ? debit.subtract(credit) : credit.subtract(debit);
  }
}

function addMonthsMinusDay(iso: string, months: number): string {
  const next = addMonths(iso, months);
  const t = new Date(`${next}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
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
