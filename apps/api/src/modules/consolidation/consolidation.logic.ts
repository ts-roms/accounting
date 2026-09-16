import { Money } from '@accounting/money';
import type {
  AccountType,
  ConsolidationAdjustmentType,
  ConsolidationGroupAccounts,
  ConsolidationMethod,
  EliminationRuleConfig,
  EliminationRuleType,
  TranslationMethod,
} from '@accounting/types';

/*
 * Pure consolidation engine (Prompt #9). Translation, eliminations,
 * non-controlling interest, equity pickup and the group trial balance /
 * statements are arithmetic over member trial balances the service reads
 * from the ledgers. Nothing here touches a database.
 */

export const DEBIT_NATURAL: readonly AccountType[] = [
  'ASSET',
  'EXPENSE',
  'COST_OF_SALES',
  'OTHER_EXPENSE',
];
export const BALANCE_SHEET_TYPES: readonly AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY'];
export const isDebitNatural = (type: AccountType) => DEBIT_NATURAL.includes(type);
export const isBalanceSheet = (type: AccountType) => BALANCE_SHEET_TYPES.includes(type);

/** Natural-signed balance from raw debit / credit totals. */
export function naturalBalance(type: AccountType, debit: Money, credit: Money): Money {
  return isDebitNatural(type) ? debit.subtract(credit) : credit.subtract(debit);
}

export interface MemberRates {
  closing: string;
  average: string;
  historical: string;
  opening: string;
}

export interface MemberRow {
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  isIntercompany: boolean;
  /** Natural-signed cumulative balance at period end (balance sheet), member currency. */
  closing: string;
  /** Natural-signed cumulative balance at period start. */
  opening: string;
  /** Natural-signed activity from the fiscal year start to period end (profit and loss). */
  period: string;
}

export interface MemberInput {
  companyId: string;
  code: string;
  name: string;
  currency: string;
  method: ConsolidationMethod;
  /** 0-100. */
  ownershipPercent: string;
  isParent: boolean;
  /** Member currency. */
  acquisitionEquity: string;
  /** Presentation currency (already translated by the service at the parent's historical rate). */
  investmentCost: string;
  rates: MemberRates;
  rows: MemberRow[];
}

export interface ChartEntry {
  name: string;
  type: AccountType;
  subtype: string | null;
}

export interface AdjustmentLine {
  companyId: string | null;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: string;
  credit: string;
  description: string | null;
}

export interface GeneratedAdjustment {
  type: ConsolidationAdjustmentType;
  ruleId: string | null;
  companyId: string | null;
  description: string;
  lines: AdjustmentLine[];
}

export interface RuleInput {
  id: string;
  code: string;
  type: EliminationRuleType;
  config: EliminationRuleConfig;
}

export interface TranslatedRow {
  companyId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  isIntercompany: boolean;
  /** Natural-signed, presentation currency, after proportional scaling. */
  amount: Money;
  /** Member-currency figure it came from (before scaling). */
  local: string;
  rate: string;
}

export interface TranslatedMember {
  companyId: string;
  method: ConsolidationMethod;
  share: number;
  rows: TranslatedRow[];
  /** Plug that keeps the translated column balanced (credit-natural, CTA account). */
  translationAdjustment: Money;
  netIncome: Money;
  totalEquity: Money;
}

const pct = (v: string) => Number(v) / 100;

/**
 * Translate one member into the presentation currency. CURRENT_RATE: balance
 * sheet at closing, equity at historical, P&L at average; the difference is
 * the cumulative translation adjustment. CLOSING_RATE: everything at closing.
 */
export function translateMember(
  member: MemberInput,
  method: TranslationMethod,
  currency: string,
  accounts: ConsolidationGroupAccounts,
): TranslatedMember {
  const share = member.method === 'PROPORTIONAL' ? pct(member.ownershipPercent) : 1;
  const rows: TranslatedRow[] = [];
  let debits = Money.zero(currency);
  let credits = Money.zero(currency);
  let netIncome = Money.zero(currency);
  let totalEquity = Money.zero(currency);
  for (const r of member.rows) {
    const local = Money.of(isBalanceSheet(r.type) ? r.closing : r.period, member.currency);
    if (local.isZero()) continue;
    const rate =
      method === 'CLOSING_RATE'
        ? member.rates.closing
        : r.type === 'EQUITY'
          ? member.rates.historical
          : isBalanceSheet(r.type)
            ? member.rates.closing
            : member.rates.average;
    const amount = local.convert(currency, rate).multiply(share);
    rows.push({
      companyId: member.companyId,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      isIntercompany: r.isIntercompany,
      amount,
      local: local.toString(),
      rate,
    });
    if (isDebitNatural(r.type)) debits = debits.add(amount);
    else credits = credits.add(amount);
    if (!isBalanceSheet(r.type))
      netIncome = netIncome.add(
        r.type === 'REVENUE' || r.type === 'OTHER_INCOME' ? amount : amount.negate(),
      );
    if (r.type === 'EQUITY') totalEquity = totalEquity.add(amount);
  }
  // Debit-natural balances must equal credit-natural ones; whatever is missing is the translation difference.
  const translationAdjustment = debits.subtract(credits);
  if (!translationAdjustment.isZero()) {
    rows.push({
      companyId: member.companyId,
      code: accounts.cumulativeTranslationAdjustment,
      name: 'Cumulative translation adjustment',
      type: 'EQUITY',
      subtype: 'OTHER_EQUITY',
      isIntercompany: false,
      amount: translationAdjustment,
      local: '0',
      rate: '-',
    });
    totalEquity = totalEquity.add(translationAdjustment);
  }
  return {
    companyId: member.companyId,
    method: member.method,
    share,
    rows,
    translationAdjustment,
    netIncome,
    totalEquity,
  };
}

const line = (
  chart: Map<string, ChartEntry>,
  companyId: string | null,
  accountCode: string,
  side: 'debit' | 'credit',
  amount: Money,
  description: string | null = null,
  fallback?: Partial<ChartEntry>,
): AdjustmentLine => {
  const entry = chart.get(accountCode) ?? {
    name: fallback?.name ?? accountCode,
    type: fallback?.type ?? 'EQUITY',
    subtype: fallback?.subtype ?? null,
  };
  return {
    companyId,
    accountCode,
    accountName: entry.name,
    accountType: entry.type,
    debit: side === 'debit' ? amount.toString() : '0',
    credit: side === 'credit' ? amount.toString() : '0',
    description,
  };
};

/** Debit / credit that reverses a natural-signed balance. */
const reversing = (type: AccountType, amount: Money): 'debit' | 'credit' =>
  isDebitNatural(type)
    ? amount.isPositive()
      ? 'credit'
      : 'debit'
    : amount.isPositive()
      ? 'debit'
      : 'credit';

export interface EngineInput {
  currency: string;
  translationMethod: TranslationMethod;
  accounts: ConsolidationGroupAccounts;
  members: MemberInput[];
  rules: RuleInput[];
  /** Code -> name / type from the parent chart (members' charts fill gaps). */
  chart: Map<string, ChartEntry>;
}

/** Everything the run needs to store: translated columns plus the adjustments the rules generate. */
export interface EngineOutput {
  translated: TranslatedMember[];
  adjustments: GeneratedAdjustment[];
}

export function runEngine(input: EngineInput): EngineOutput {
  const { currency, accounts, chart } = input;
  const translated = input.members
    .filter((m) => m.method !== 'EQUITY')
    .map((m) => translateMember(m, input.translationMethod, currency, accounts));
  const byId = new Map(input.members.map((m) => [m.companyId, m]));
  const parent = input.members.find((m) => m.isParent) ?? null;
  const adjustments: GeneratedAdjustment[] = [];
  const zero = Money.zero(currency);

  for (const rule of input.rules) {
    if (rule.type === 'INTERCOMPANY_BALANCES') {
      const lines: AdjustmentLine[] = [];
      let debit = zero;
      let credit = zero;
      for (const t of translated)
        for (const r of t.rows) {
          // Balance-sheet accounts only; intercompany revenue / expense is an INTERCOMPANY_PROFIT_LOSS rule.
          if (!r.isIntercompany || !isBalanceSheet(r.type) || r.amount.isZero()) continue;
          const side = reversing(r.type, r.amount);
          lines.push(
            line(
              chart,
              t.companyId,
              r.code,
              side,
              r.amount.abs(),
              `Eliminate ${r.code} ${r.name}`,
              r,
            ),
          );
          if (side === 'debit') debit = debit.add(r.amount.abs());
          else credit = credit.add(r.amount.abs());
        }
      if (!lines.length) continue;
      const diff = debit.subtract(credit);
      if (!diff.isZero())
        lines.push(
          line(
            chart,
            null,
            accounts.intercompanyDifference,
            diff.isPositive() ? 'credit' : 'debit',
            diff.abs(),
            'Intercompany balances not mirrored (timing / FX)',
          ),
        );
      adjustments.push({
        type: 'ELIMINATION',
        ruleId: rule.id,
        companyId: null,
        description: `${rule.code}: intercompany receivables and payables`,
        lines,
      });
    } else if (rule.type === 'INTERCOMPANY_PROFIT_LOSS') {
      const rev = new Set(rule.config.revenueCodes ?? []);
      const exp = new Set(rule.config.expenseCodes ?? []);
      const lines: AdjustmentLine[] = [];
      let debit = zero;
      let credit = zero;
      for (const t of translated)
        for (const r of t.rows) {
          if (r.amount.isZero()) continue;
          if (rev.has(r.code) || exp.has(r.code)) {
            const side = reversing(r.type, r.amount);
            lines.push(
              line(
                chart,
                t.companyId,
                r.code,
                side,
                r.amount.abs(),
                `Eliminate intercompany ${rev.has(r.code) ? 'revenue' : 'expense'}`,
                r,
              ),
            );
            if (side === 'debit') debit = debit.add(r.amount.abs());
            else credit = credit.add(r.amount.abs());
          }
        }
      if (!lines.length) continue;
      const diff = debit.subtract(credit);
      if (!diff.isZero())
        lines.push(
          line(
            chart,
            null,
            accounts.intercompanyDifference,
            diff.isPositive() ? 'credit' : 'debit',
            diff.abs(),
            'Intercompany revenue and expense not mirrored',
          ),
        );
      adjustments.push({
        type: 'ELIMINATION',
        ruleId: rule.id,
        companyId: null,
        description: `${rule.code}: intercompany revenue and expense`,
        lines,
      });
    } else if (rule.type === 'INVESTMENT_EQUITY') {
      for (const t of translated) {
        const m = byId.get(t.companyId)!;
        if (m.isParent) continue;
        const share = pct(m.ownershipPercent);
        const equityAtAcquisition = Money.of(m.acquisitionEquity, m.currency).convert(
          currency,
          m.rates.historical,
        );
        const investment = Money.of(m.investmentCost, currency);
        if (equityAtAcquisition.isZero() && investment.isZero()) continue;
        const lines: AdjustmentLine[] = [];
        // Debit the subsidiary's equity at acquisition: share capital first, then reserves.
        let remaining = equityAtAcquisition;
        const equityRows = t.rows
          .filter(
            (r) =>
              r.type === 'EQUITY' &&
              r.code !== accounts.cumulativeTranslationAdjustment &&
              r.amount.isPositive(),
          )
          .sort((a, b) =>
            a.subtype === 'SHARE_CAPITAL'
              ? -1
              : b.subtype === 'SHARE_CAPITAL'
                ? 1
                : a.code.localeCompare(b.code),
          );
        for (const r of equityRows) {
          if (remaining.isZero()) break;
          const take = r.amount.lessThan(remaining) ? r.amount : remaining;
          lines.push(
            line(
              chart,
              t.companyId,
              r.code,
              'debit',
              take,
              `Eliminate ${m.code} equity at acquisition`,
              r,
            ),
          );
          remaining = remaining.subtract(take);
        }
        if (remaining.isPositive())
          lines.push(
            line(
              chart,
              t.companyId,
              accounts.retainedEarnings,
              'debit',
              remaining,
              `Eliminate ${m.code} pre-acquisition reserves`,
            ),
          );
        if (investment.isPositive())
          lines.push(
            line(
              chart,
              parent?.companyId ?? null,
              accounts.investment,
              'credit',
              investment,
              `Investment in ${m.code}`,
            ),
          );
        const nci = equityAtAcquisition.multiply(1 - share);
        if (nci.isPositive())
          lines.push(
            line(
              chart,
              null,
              accounts.nonControllingInterest,
              'credit',
              nci,
              `Non-controlling interest in ${m.code} at acquisition`,
            ),
          );
        const goodwill = investment.subtract(equityAtAcquisition.multiply(share));
        if (goodwill.isPositive())
          lines.push(
            line(
              chart,
              null,
              accounts.goodwill,
              'debit',
              goodwill,
              `Goodwill on acquisition of ${m.code}`,
            ),
          );
        else if (goodwill.isNegative())
          lines.push(
            line(
              chart,
              null,
              accounts.retainedEarnings,
              'credit',
              goodwill.abs(),
              `Bargain purchase gain on ${m.code}`,
            ),
          );
        adjustments.push({
          type: 'ELIMINATION',
          ruleId: rule.id,
          companyId: t.companyId,
          description: `${rule.code}: investment in ${m.code} against equity at acquisition`,
          lines,
        });
        // Outside shareholders' share of reserves earned since acquisition. The current-year share is an
        // allocation of profit (see nciShareOfProfit) presented in the statements, never a journal.
        if (share < 1) {
          const postAcquisition = t.totalEquity.subtract(equityAtAcquisition);
          const nciPost = postAcquisition.multiply(1 - share);
          if (!nciPost.isZero())
            adjustments.push({
              type: 'NON_CONTROLLING_INTEREST',
              ruleId: rule.id,
              companyId: t.companyId,
              description: `Non-controlling interest in ${m.code} post-acquisition reserves`,
              lines: [
                line(
                  chart,
                  null,
                  accounts.retainedEarnings,
                  nciPost.isPositive() ? 'debit' : 'credit',
                  nciPost.abs(),
                  `${Math.round((1 - share) * 10000) / 100}% of ${m.code} post-acquisition equity`,
                ),
                line(
                  chart,
                  null,
                  accounts.nonControllingInterest,
                  nciPost.isPositive() ? 'credit' : 'debit',
                  nciPost.abs(),
                  `NCI in ${m.code}`,
                ),
              ],
            });
        }
      }
      // Equity-accounted members: share of results picked up into the investment.
      for (const m of input.members) {
        if (m.method !== 'EQUITY') continue;
        const t = translateMember(m, input.translationMethod, currency, accounts);
        const pickup = t.netIncome.multiply(pct(m.ownershipPercent));
        if (pickup.isZero()) continue;
        adjustments.push({
          type: 'EQUITY_PICKUP',
          ruleId: rule.id,
          companyId: m.companyId,
          description: `Share of ${m.code} result (equity method, ${m.ownershipPercent}%)`,
          lines: [
            line(
              chart,
              parent?.companyId ?? null,
              accounts.investment,
              pickup.isPositive() ? 'debit' : 'credit',
              pickup.abs(),
              `Investment in ${m.code}`,
            ),
            line(
              chart,
              null,
              accounts.shareOfAssociateProfit,
              pickup.isPositive() ? 'credit' : 'debit',
              pickup.abs(),
              `Share of profit of ${m.code}`,
            ),
          ],
        });
      }
    } else if (rule.type === 'UNREALIZED_PROFIT') {
      const amount = Money.of(rule.config.amount ?? '0', currency);
      if (amount.isZero() || !rule.config.inventoryCode || !rule.config.costOfSalesCode) continue;
      adjustments.push({
        type: 'ELIMINATION',
        ruleId: rule.id,
        companyId: null,
        description: `${rule.code}: unrealized profit in closing inventory`,
        lines: [
          line(
            chart,
            null,
            rule.config.costOfSalesCode,
            'debit',
            amount,
            'Unrealized intercompany profit',
          ),
          line(chart, null, rule.config.inventoryCode, 'credit', amount, 'Inventory at group cost'),
        ],
      });
    } else if (rule.type === 'CUSTOM') {
      const lines = (rule.config.lines ?? []).map((l) => {
        const debit = Money.of(l.debit ?? '0', currency);
        const credit = Money.of(l.credit ?? '0', currency);
        return line(
          chart,
          l.companyId ?? null,
          l.accountCode,
          debit.isPositive() ? 'debit' : 'credit',
          debit.isPositive() ? debit : credit,
          l.description ?? null,
        );
      });
      if (lines.length)
        adjustments.push({
          type: 'ELIMINATION',
          ruleId: rule.id,
          companyId: null,
          description: `${rule.code}`,
          lines,
        });
    }
  }
  return { translated, adjustments };
}

// ------------------------------------------------------------ consolidation

export interface StoredAdjustmentLine {
  companyId: string | null;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: string;
  credit: string;
}

export interface ConsolidatedRow {
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  isIntercompany: boolean;
  byCompany: Record<string, string>;
  combined: string;
  adjustments: string;
  consolidated: string;
}

export interface ConsolidatedTotals {
  assets: string;
  liabilities: string;
  equity: string;
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  expenses: string;
  netIncome: string;
  nonControllingInterest: string;
  translationAdjustment: string;
  /** assets - liabilities - equity - netIncome; zero when the group balances. */
  difference: string;
  balanced: boolean;
}

/** Combine translated columns and active adjustment lines into the group trial balance. */
export function consolidate(
  translated: TranslatedMember[],
  adjustmentLines: StoredAdjustmentLine[],
  currency: string,
  accounts: ConsolidationGroupAccounts,
  chart: Map<string, ChartEntry>,
): { rows: ConsolidatedRow[]; totals: ConsolidatedTotals } {
  const rows = new Map<string, ConsolidatedRow & { combinedM: Money; adjM: Money }>();
  const ensure = (code: string, entry: ChartEntry, isIntercompany = false) => {
    let row = rows.get(code);
    if (!row) {
      row = {
        code,
        name: entry.name,
        type: entry.type,
        subtype: entry.subtype,
        isIntercompany,
        byCompany: {},
        combined: '0',
        adjustments: '0',
        consolidated: '0',
        combinedM: Money.zero(currency),
        adjM: Money.zero(currency),
      };
      rows.set(code, row);
    }
    return row;
  };
  for (const t of translated)
    for (const r of t.rows) {
      const row = ensure(r.code, r, r.isIntercompany);
      row.isIntercompany = row.isIntercompany || r.isIntercompany;
      row.byCompany[t.companyId] = Money.of(row.byCompany[t.companyId] ?? '0', currency)
        .add(r.amount)
        .toString();
      row.combinedM = row.combinedM.add(r.amount);
    }
  for (const l of adjustmentLines) {
    const entry = chart.get(l.accountCode) ?? {
      name: l.accountName,
      type: l.accountType,
      subtype: null,
    };
    const row = ensure(l.accountCode, {
      name: l.accountName || entry.name,
      type: l.accountType || entry.type,
      subtype: entry.subtype,
    });
    const effect = naturalBalance(
      row.type,
      Money.of(l.debit, currency),
      Money.of(l.credit, currency),
    );
    row.adjM = row.adjM.add(effect);
  }
  const out: ConsolidatedRow[] = [...rows.values()]
    .map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      isIntercompany: r.isIntercompany,
      byCompany: r.byCompany,
      combined: r.combinedM.toString(),
      adjustments: r.adjM.toString(),
      consolidated: r.combinedM.add(r.adjM).toString(),
    }))
    .filter((r) => !(r.combined === '0.0000' && r.adjustments === '0.0000'))
    .sort((a, b) => a.code.localeCompare(b.code));
  const total = (pred: (r: ConsolidatedRow) => boolean) =>
    out
      .filter(pred)
      .reduce((m, r) => m.add(Money.of(r.consolidated, currency)), Money.zero(currency));
  const assets = total((r) => r.type === 'ASSET');
  const liabilities = total((r) => r.type === 'LIABILITY');
  const equity = total((r) => r.type === 'EQUITY');
  const revenue = total((r) => r.type === 'REVENUE' || r.type === 'OTHER_INCOME');
  const costOfSales = total((r) => r.type === 'COST_OF_SALES');
  const expenses = total((r) => r.type === 'EXPENSE' || r.type === 'OTHER_EXPENSE');
  const netIncome = revenue.subtract(costOfSales).subtract(expenses);
  const difference = assets.subtract(liabilities).subtract(equity).subtract(netIncome);
  return {
    rows: out,
    totals: {
      assets: assets.toString(),
      liabilities: liabilities.toString(),
      equity: equity.toString(),
      revenue: revenue.toString(),
      costOfSales: costOfSales.toString(),
      grossProfit: revenue.subtract(costOfSales).toString(),
      expenses: expenses.toString(),
      netIncome: netIncome.toString(),
      nonControllingInterest: total((r) => r.code === accounts.nonControllingInterest).toString(),
      translationAdjustment: total(
        (r) => r.code === accounts.cumulativeTranslationAdjustment,
      ).toString(),
      difference: difference.toString(),
      balanced: difference.isZero(),
    },
  };
}

/** Simple average of the rates in force on each day of the window. */
export function averageRate(dailyRates: readonly string[]): string {
  if (!dailyRates.length) return '1';
  const sum = dailyRates.reduce((s, r) => s + Number(r), 0);
  return (sum / dailyRates.length).toFixed(8);
}

/** Adjustment lines must balance. */
export function adjustmentTotals(
  lines: ReadonlyArray<{ debit: string; credit: string }>,
  currency: string,
): { debit: string; credit: string; balanced: boolean } {
  const debit = lines.reduce((m, l) => m.add(Money.of(l.debit, currency)), Money.zero(currency));
  const credit = lines.reduce((m, l) => m.add(Money.of(l.credit, currency)), Money.zero(currency));
  return { debit: debit.toString(), credit: credit.toString(), balanced: debit.equals(credit) };
}

/** Profit attributable to outside shareholders, per fully consolidated member. */
export function nciShareOfProfit(
  translated: TranslatedMember[],
  members: MemberInput[],
  currency: string,
): Money {
  const byId = new Map(members.map((m) => [m.companyId, m]));
  return translated.reduce((sum, t) => {
    const m = byId.get(t.companyId);
    if (!m || m.isParent || m.method !== 'FULL') return sum;
    return sum.add(t.netIncome.multiply(1 - pct(m.ownershipPercent)));
  }, Money.zero(currency));
}
