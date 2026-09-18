import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import {
  INCOME_STATEMENT_TYPES,
  NORMAL_BALANCE_BY_TYPE,
  type AccountType,
} from '@accounting/types';
import type {
  BalanceSheetQuery,
  CashFlowQuery,
  IncomeStatementQuery,
  IncomeStatementTrendQuery,
  TrialBalanceQuery,
} from '@accounting/validation';
import {
  GeneralLedgerService,
  signedBalance,
  type AccountActivity,
} from '@/modules/accounting/ledger/general-ledger.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { accounts, type Account } from '@/database/schema';
import { buildCashFlowStatement, type CashFlowStatement } from './cash-flow.logic';

export type { CashFlowStatement } from './cash-flow.logic';

/** Branch and dimension filters forwarded to the ledger. */
const dims = (q: {
  branchId?: string;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}) => ({
  branchId: q.branchId,
  departmentId: q.departmentId,
  costCenterId: q.costCenterId,
  projectId: q.projectId,
});

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: Account['normalBalance'];
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceReport {
  from: string;
  to: string;
  currency: string;
  rows: TrialBalanceRow[];
  totals: Omit<TrialBalanceRow, 'accountId' | 'code' | 'name' | 'type' | 'normalBalance'>;
  balanced: boolean;
}

export interface StatementRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  level: number;
  isHeader: boolean;
  /** Signed by the natural balance of the account type (revenue positive, expense positive). */
  amount: string;
  /** Drill-down descriptor for the general ledger. */
  drill: { accountId: string; from: string | null; to: string };
}

export interface StatementSection {
  key: string;
  title: string;
  rows: StatementRow[];
  total: string;
}

export interface IncomeStatementReport {
  from: string;
  to: string;
  currency: string;
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfit: string;
  expenses: StatementSection;
  /** Gross profit - operating expenses. */
  operatingIncome: string;
  otherIncome: StatementSection;
  otherExpenses: StatementSection;
  netIncome: string;
  /** Same structure for the comparative window, when one was requested. */
  comparative?: Omit<IncomeStatementReport, 'comparative'>;
}

/** Section totals of one month, for trend charts (no rows). */
export interface IncomeStatementTrendPoint {
  from: string;
  to: string;
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  expenses: string;
  operatingIncome: string;
  otherIncome: string;
  otherExpenses: string;
  netIncome: string;
}

export interface IncomeStatementTrend {
  currency: string;
  months: IncomeStatementTrendPoint[];
}

export interface BalanceSheetReport {
  asOf: string;
  currency: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  /** Cumulative unclosed profit (income-statement accounts not yet transferred to retained earnings). */
  currentEarnings: string;
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

/**
 * Financial statements derived on demand from the general ledger. The
 * hierarchy comes from the chart of accounts; header amounts are the sum of
 * their descendants, so Net Income -> Revenue -> account -> ledger always ties.
 */
@Injectable()
export class ReportingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ledger: GeneralLedgerService,
  ) {}

  async trialBalance(companyId: string, query: TrialBalanceQuery): Promise<TrialBalanceReport> {
    const currency = await this.ledger.currency(companyId);
    const dayBefore = previousDay(query.from);
    const [opening, period, chart] = await Promise.all([
      this.ledger.activity({ companyId, to: dayBefore, ...dims(query) }),
      this.ledger.activity({ companyId, from: query.from, to: query.to, ...dims(query) }),
      this.db
        .select()
        .from(accounts)
        .where(eq(accounts.companyId, companyId))
        .orderBy(asc(accounts.code)),
    ]);
    const openingBy = index(opening);
    const periodBy = index(period);

    const rows: TrialBalanceRow[] = [];
    const totals = {
      openingDebit: Money.zero(currency),
      openingCredit: Money.zero(currency),
      periodDebit: Money.zero(currency),
      periodCredit: Money.zero(currency),
      closingDebit: Money.zero(currency),
      closingCredit: Money.zero(currency),
    };

    for (const account of chart) {
      if (account.isHeader) continue;
      const o = openingBy.get(account.id);
      const p = periodBy.get(account.id);
      const openingNet = o
        ? Money.of(o.debit, currency).subtract(Money.of(o.credit, currency))
        : Money.zero(currency);
      const periodDebit = p ? Money.of(p.debit, currency) : Money.zero(currency);
      const periodCredit = p ? Money.of(p.credit, currency) : Money.zero(currency);
      const closingNet = openingNet.add(periodDebit).subtract(periodCredit);
      if (
        !query.includeZero &&
        openingNet.isZero() &&
        periodDebit.isZero() &&
        periodCredit.isZero()
      )
        continue;

      const [openingDebit, openingCredit] = split(openingNet, currency);
      const [closingDebit, closingCredit] = split(closingNet, currency);
      rows.push({
        accountId: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
        openingDebit: openingDebit.toString(),
        openingCredit: openingCredit.toString(),
        periodDebit: periodDebit.toString(),
        periodCredit: periodCredit.toString(),
        closingDebit: closingDebit.toString(),
        closingCredit: closingCredit.toString(),
      });
      totals.openingDebit = totals.openingDebit.add(openingDebit);
      totals.openingCredit = totals.openingCredit.add(openingCredit);
      totals.periodDebit = totals.periodDebit.add(periodDebit);
      totals.periodCredit = totals.periodCredit.add(periodCredit);
      totals.closingDebit = totals.closingDebit.add(closingDebit);
      totals.closingCredit = totals.closingCredit.add(closingCredit);
    }

    return {
      from: query.from,
      to: query.to,
      currency,
      rows,
      totals: Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [k, v.toString()]),
      ) as TrialBalanceReport['totals'],
      balanced:
        totals.periodDebit.equals(totals.periodCredit) &&
        totals.closingDebit.equals(totals.closingCredit),
    };
  }

  async incomeStatement(
    companyId: string,
    query: IncomeStatementQuery,
  ): Promise<IncomeStatementReport> {
    const currency = await this.ledger.currency(companyId);
    const [activity, chart] = await Promise.all([
      this.ledger.activity({
        companyId,
        from: query.from,
        to: query.to,
        ...dims(query),
        accountTypes: INCOME_STATEMENT_TYPES,
      }),
      this.db
        .select()
        .from(accounts)
        .where(eq(accounts.companyId, companyId))
        .orderBy(asc(accounts.code)),
    ]);
    const amounts = rollUp(chart, activity, currency);
    const section = (key: string, title: string, type: AccountType) =>
      buildSection(key, title, chart, amounts, [type], currency, query.from, query.to);

    const revenue = section('revenue', 'Revenue', 'REVENUE');
    const costOfSales = section('costOfSales', 'Cost of sales', 'COST_OF_SALES');
    const expenses = section('expenses', 'Operating expenses', 'EXPENSE');
    const otherIncome = section('otherIncome', 'Other income', 'OTHER_INCOME');
    const otherExpenses = section('otherExpenses', 'Other expenses', 'OTHER_EXPENSE');
    const grossProfit = Money.of(revenue.total, currency).subtract(
      Money.of(costOfSales.total, currency),
    );
    const operatingIncome = grossProfit.subtract(Money.of(expenses.total, currency));
    const netIncome = operatingIncome
      .add(Money.of(otherIncome.total, currency))
      .subtract(Money.of(otherExpenses.total, currency));
    const report: IncomeStatementReport = {
      from: query.from,
      to: query.to,
      currency,
      revenue,
      costOfSales,
      grossProfit: grossProfit.toString(),
      expenses,
      operatingIncome: operatingIncome.toString(),
      otherIncome,
      otherExpenses,
      netIncome: netIncome.toString(),
    };
    if (query.compareFrom && query.compareTo) {
      const { compareFrom: _f, compareTo: _t, ...rest } = query;
      report.comparative = await this.incomeStatement(companyId, {
        ...rest,
        from: query.compareFrom,
        to: query.compareTo,
      });
    }
    return report;
  }

  /**
   * Income statement totals per calendar month for the `months` months ending
   * in the month of `to`. One ledger read for the whole window: the dashboard
   * trend used to issue one full report per month.
   */
  async incomeStatementTrend(
    companyId: string,
    query: IncomeStatementTrendQuery,
  ): Promise<IncomeStatementTrend> {
    const currency = await this.ledger.currency(companyId);
    const months = monthWindows(query.to, query.months);
    const first = months[0]!;
    const [activity, chart] = await Promise.all([
      this.ledger.activityByMonth({
        companyId,
        from: first.from,
        to: query.to,
        branchId: query.branchId,
        accountTypes: INCOME_STATEMENT_TYPES,
      }),
      this.db
        .select()
        .from(accounts)
        .where(eq(accounts.companyId, companyId))
        .orderBy(asc(accounts.code)),
    ]);
    const points = months.map((m) => {
      const amounts = rollUp(
        chart,
        activity.filter((a) => a.month === m.from),
        currency,
      );
      const total = (type: AccountType) =>
        Money.of(
          buildSection(type, type, chart, amounts, [type], currency, m.from, m.to).total,
          currency,
        );
      const revenue = total('REVENUE');
      const costOfSales = total('COST_OF_SALES');
      const expenses = total('EXPENSE');
      const otherIncome = total('OTHER_INCOME');
      const otherExpenses = total('OTHER_EXPENSE');
      const grossProfit = revenue.subtract(costOfSales);
      const operatingIncome = grossProfit.subtract(expenses);
      const netIncome = operatingIncome.add(otherIncome).subtract(otherExpenses);
      return {
        from: m.from,
        to: m.to,
        revenue: revenue.toString(),
        costOfSales: costOfSales.toString(),
        grossProfit: grossProfit.toString(),
        expenses: expenses.toString(),
        operatingIncome: operatingIncome.toString(),
        otherIncome: otherIncome.toString(),
        otherExpenses: otherExpenses.toString(),
        netIncome: netIncome.toString(),
      };
    });
    return { currency, months: points };
  }

  /**
   * Indirect cash-flow statement from ledger movements. Year-end CLOSING
   * journals are excluded: they only move unclosed profit into retained
   * earnings and would otherwise cancel net income in a window that spans a
   * year end.
   */
  async cashFlow(companyId: string, query: CashFlowQuery): Promise<CashFlowStatement> {
    const currency = await this.ledger.currency(companyId);
    const dayBefore = previousDay(query.from);
    const [opening, period, chart] = await Promise.all([
      this.ledger.activity({
        companyId,
        to: dayBefore,
        branchId: query.branchId,
        excludeJournalTypes: ['CLOSING'],
      }),
      this.ledger.activity({
        companyId,
        from: query.from,
        to: query.to,
        branchId: query.branchId,
        excludeJournalTypes: ['CLOSING'],
      }),
      this.db
        .select()
        .from(accounts)
        .where(eq(accounts.companyId, companyId))
        .orderBy(asc(accounts.code)),
    ]);
    return buildCashFlowStatement({
      chart,
      opening,
      period,
      currency,
      from: query.from,
      to: query.to,
    });
  }

  async balanceSheet(companyId: string, query: BalanceSheetQuery): Promise<BalanceSheetReport> {
    const currency = await this.ledger.currency(companyId);
    const [activity, chart] = await Promise.all([
      this.ledger.activity({ companyId, to: query.asOf, branchId: query.branchId }),
      this.db
        .select()
        .from(accounts)
        .where(eq(accounts.companyId, companyId))
        .orderBy(asc(accounts.code)),
    ]);
    const amounts = rollUp(chart, activity, currency);
    const section = (key: string, title: string, type: AccountType) =>
      buildSection(key, title, chart, amounts, [type], currency, null, query.asOf);

    const assets = section('assets', 'Assets', 'ASSET');
    const liabilities = section('liabilities', 'Liabilities', 'LIABILITY');
    const equity = section('equity', 'Equity', 'EQUITY');

    // P&L accounts that have not been closed to retained earnings yet:
    // net credit (revenue - cost of sales - expenses) regardless of normal side.
    const chartById = new Map(chart.map((a) => [a.id, a]));
    let currentEarnings = Money.zero(currency);
    for (const row of activity) {
      const account = chartById.get(row.accountId);
      if (!account || !INCOME_STATEMENT_TYPES.includes(account.type)) continue;
      currentEarnings = currentEarnings.add(
        Money.of(row.credit, currency).subtract(Money.of(row.debit, currency)),
      );
    }
    const totalAssets = Money.of(assets.total, currency);
    const totalLE = Money.of(liabilities.total, currency)
      .add(Money.of(equity.total, currency))
      .add(currentEarnings);
    return {
      asOf: query.asOf,
      currency,
      assets,
      liabilities,
      equity,
      currentEarnings: currentEarnings.toString(),
      totalAssets: totalAssets.toString(),
      totalLiabilitiesAndEquity: totalLE.toString(),
      balanced: totalAssets.equals(totalLE),
    };
  }
}

// ------------------------------------------------------------------- helpers

function index(rows: AccountActivity[]): Map<string, AccountActivity> {
  return new Map(rows.map((r) => [r.accountId, r]));
}

function split(net: Money, currency: string): [Money, Money] {
  return net.isNegative() ? [Money.zero(currency), net.abs()] : [net, Money.zero(currency)];
}

/** Calendar months ending in the month of `to`, oldest first; the last month ends on `to`. */
function monthWindows(to: string, count: number): { from: string; to: string }[] {
  const [y, m] = to.split('-').map(Number) as [number, number];
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return Array.from({ length: count }, (_, i) => {
    const offset = count - 1 - i;
    const from = new Date(Date.UTC(y, m - 1 - offset, 1));
    const end = new Date(Date.UTC(y, m - offset, 0));
    return { from: iso(from), to: offset === 0 ? to : iso(end) };
  });
}

function previousDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Signed amount per account with header accounts holding the sum of their
 * descendants. Amounts are signed by the natural side of the account TYPE (not
 * the individual account), so contra accounts such as accumulated depreciation
 * present as negative assets and sections total correctly.
 */
function rollUp(
  chart: Account[],
  activity: AccountActivity[],
  currency: string,
): Map<string, Money> {
  const byId = new Map(chart.map((a) => [a.id, a]));
  const amounts = new Map<string, Money>();
  for (const row of activity) {
    const account = byId.get(row.accountId);
    if (!account) continue;
    const net = Money.of(row.debit, currency).subtract(Money.of(row.credit, currency));
    const signed = signedBalance(net, NORMAL_BALANCE_BY_TYPE[account.type]);
    // Propagate to the account and every ancestor.
    let current: Account | undefined = account;
    for (let depth = 0; current && depth < 32; depth += 1) {
      amounts.set(current.id, (amounts.get(current.id) ?? Money.zero(currency)).add(signed));
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return amounts;
}

function buildSection(
  key: string,
  title: string,
  chart: Account[],
  amounts: Map<string, Money>,
  types: AccountType[],
  currency: string,
  from: string | null,
  to: string,
): StatementSection {
  const inScope = chart.filter(
    (a) => types.includes(a.type) && (a.status === 'ACTIVE' || amounts.has(a.id)),
  );
  const ids = new Set(inScope.map((a) => a.id));
  const byParent = new Map<string | null, Account[]>();
  for (const a of inScope) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), a]);
  }
  const rows: StatementRow[] = [];
  let total = Money.zero(currency);
  const visit = (parentId: string | null, level: number) => {
    for (const a of (byParent.get(parentId) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      const amount = amounts.get(a.id) ?? Money.zero(currency);
      if (amount.isZero() && !a.isHeader) continue; // keep statements readable
      rows.push({
        accountId: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        level,
        isHeader: a.isHeader,
        amount: amount.toString(),
        drill: { accountId: a.id, from, to },
      });
      if (parentId === null) total = total.add(amount);
      visit(a.id, level + 1);
    }
  };
  visit(null, 0);
  // Drop headers that ended up with no visible children and zero amount.
  const cleaned = rows.filter(
    (r, i) =>
      !(
        r.isHeader &&
        Money.of(r.amount, currency).isZero() &&
        !(rows[i + 1] && rows[i + 1]!.level > r.level)
      ),
  );
  return { key, title, rows: cleaned, total: total.toString() };
}
