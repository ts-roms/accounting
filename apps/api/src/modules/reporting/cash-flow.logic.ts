import { Money } from '@accounting/money';
import {
  BALANCE_SHEET_TYPES,
  INCOME_STATEMENT_TYPES,
  type AccountSubtype,
  type AccountType,
  type CashFlowActivity,
} from '@accounting/types';

/*
 * Indirect-method cash flow, derived purely from ledger movements:
 *
 *   net income
 *   + / - change in every non-cash balance-sheet account   (operating / investing / financing)
 *   = net change in cash
 *
 * Because every posted entry balances, the sum of the classified changes is
 * exactly the movement on the cash accounts - the statement reconciles by
 * construction and `balanced` proves it on every run. Pure: no I/O.
 */

export interface CashFlowAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype | null;
  isHeader: boolean;
  cashFlowActivity: CashFlowActivity | null;
}

export interface AccountMovement {
  accountId: string;
  debit: string;
  credit: string;
}

export interface CashFlowLine {
  accountId: string;
  code: string;
  name: string;
  /** Cash effect: positive = source of cash, negative = use of cash. */
  amount: string;
  drill: { accountId: string; from: string; to: string };
}

export interface CashFlowSection {
  key: CashFlowActivity;
  title: string;
  lines: CashFlowLine[];
  total: string;
}

export interface CashFlowStatement {
  method: 'INDIRECT';
  from: string;
  to: string;
  currency: string;
  netIncome: string;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChangeInCash: string;
  openingCash: string;
  closingCash: string;
  /** netChangeInCash equals the movement on the cash accounts. */
  balanced: boolean;
  cashAccounts: Array<{
    accountId: string;
    code: string;
    name: string;
    opening: string;
    closing: string;
  }>;
}

export const CASH_SUBTYPES: readonly AccountSubtype[] = ['CASH', 'BANK'];

/** Default classification by subtype when the account has no explicit activity. */
export function defaultActivity(account: CashFlowAccount): CashFlowActivity {
  if (account.cashFlowActivity) return account.cashFlowActivity;
  switch (account.subtype) {
    case 'FIXED_ASSET':
      return 'INVESTING';
    case 'LOAN':
    case 'SHARE_CAPITAL':
    case 'RETAINED_EARNINGS':
    case 'OTHER_EQUITY':
      return 'FINANCING';
    default:
      // Working capital, accruals, prepaid, tax and the depreciation add-back
      // (accumulated depreciation is a non-cash contra asset).
      return account.type === 'EQUITY' ? 'FINANCING' : 'OPERATING';
  }
}

export function isCashAccount(account: CashFlowAccount): boolean {
  return !!account.subtype && CASH_SUBTYPES.includes(account.subtype);
}

const net = (m: AccountMovement | undefined, currency: string): Money =>
  m ? Money.of(m.debit, currency).subtract(Money.of(m.credit, currency)) : Money.zero(currency);

export function buildCashFlowStatement(input: {
  chart: readonly CashFlowAccount[];
  /** Movements strictly before `from` (opening cash). */
  opening: readonly AccountMovement[];
  /** Movements within [from, to], excluding year-end CLOSING journals. */
  period: readonly AccountMovement[];
  currency: string;
  from: string;
  to: string;
}): CashFlowStatement {
  const { chart, currency, from, to } = input;
  const openingBy = new Map(input.opening.map((m) => [m.accountId, m]));
  const periodBy = new Map(input.period.map((m) => [m.accountId, m]));

  let netIncome = Money.zero(currency);
  const sections: Record<CashFlowActivity, CashFlowLine[]> = {
    OPERATING: [],
    INVESTING: [],
    FINANCING: [],
  };
  const cashAccounts: CashFlowStatement['cashAccounts'] = [];
  let openingCash = Money.zero(currency);
  let closingCash = Money.zero(currency);

  for (const account of chart) {
    if (account.isHeader) continue;
    const movement = net(periodBy.get(account.id), currency);
    if (INCOME_STATEMENT_TYPES.includes(account.type)) {
      // Credit-positive: revenue increases income, expense decreases it.
      netIncome = netIncome.subtract(movement);
      continue;
    }
    if (!BALANCE_SHEET_TYPES.includes(account.type)) continue;
    if (isCashAccount(account)) {
      const open = net(openingBy.get(account.id), currency);
      const close = open.add(movement);
      openingCash = openingCash.add(open);
      closingCash = closingCash.add(close);
      cashAccounts.push({
        accountId: account.id,
        code: account.code,
        name: account.name,
        opening: open.toString(),
        closing: close.toString(),
      });
      continue;
    }
    if (movement.isZero()) continue;
    // An increase in a debit-balance (asset) uses cash; an increase in a
    // credit balance (liability / equity / contra asset) frees cash.
    const effect = movement.negate();
    sections[defaultActivity(account)].push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      amount: effect.toString(),
      drill: { accountId: account.id, from, to },
    });
  }

  const total = (lines: CashFlowLine[], seed = Money.zero(currency)) =>
    lines.reduce((acc, l) => acc.add(Money.of(l.amount, currency)), seed);
  const operatingTotal = total(sections.OPERATING, netIncome);
  const investingTotal = total(sections.INVESTING);
  const financingTotal = total(sections.FINANCING);
  const netChange = operatingTotal.add(investingTotal).add(financingTotal);

  return {
    method: 'INDIRECT',
    from,
    to,
    currency,
    netIncome: netIncome.toString(),
    operating: {
      key: 'OPERATING',
      title: 'Operating activities',
      lines: sections.OPERATING,
      total: operatingTotal.toString(),
    },
    investing: {
      key: 'INVESTING',
      title: 'Investing activities',
      lines: sections.INVESTING,
      total: investingTotal.toString(),
    },
    financing: {
      key: 'FINANCING',
      title: 'Financing activities',
      lines: sections.FINANCING,
      total: financingTotal.toString(),
    },
    netChangeInCash: netChange.toString(),
    openingCash: openingCash.toString(),
    closingCash: closingCash.toString(),
    balanced: netChange.equals(closingCash.subtract(openingCash)),
    cashAccounts,
  };
}
