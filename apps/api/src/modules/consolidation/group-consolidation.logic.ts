import { Money } from '@accounting/money';
import type { AccountType, ConsolidationMethod } from '@accounting/types';

/**
 * Pure arithmetic of group consolidation (hardening H9): natural balances,
 * current-rate translation, the cumulative translation adjustment plug,
 * ownership scaling and the non-controlling-interest share. No I/O.
 */

export const isBalanceSheet = (type: AccountType): boolean =>
  type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY';

export const isDebitNatural = (type: AccountType): boolean =>
  type === 'ASSET' || type === 'EXPENSE' || type === 'COST_OF_SALES' || type === 'OTHER_EXPENSE';

/** Signed natural balance: debit-side types positive on debit, credit-side types positive on credit. */
export function naturalBalance(type: AccountType, debit: Money, credit: Money): Money {
  return isDebitNatural(type) ? debit.subtract(credit) : credit.subtract(debit);
}

export interface TranslationRates {
  /** Rate on the window's last day: balance-sheet items. */
  closing: string;
  /** Average of the period: profit-and-loss items. */
  average: string;
}

/**
 * Current-rate method: balance-sheet balances at the closing rate, the
 * window's P&L activity at the average rate. Equity (share capital,
 * retained earnings brought forward) is translated at the closing rate too -
 * historical rates would need acquisition data the ledger does not hold -
 * and the difference lands in the CTA plug (see `translationAdjustment`).
 */
export function translate(
  type: AccountType,
  amount: Money,
  rates: TranslationRates,
  currency: string,
): Money {
  return amount.convert(currency, isBalanceSheet(type) ? rates.closing : rates.average);
}

/** PROPORTIONATE members carry only the parent's share; FULL members carry 100%. */
export function ownershipFactor(method: ConsolidationMethod, ownershipPct: string): number {
  return method === 'PROPORTIONATE' ? Number(ownershipPct) / 100 : 1;
}

export function scale(amount: Money, factor: number): Money {
  if (factor === 1) return amount;
  return amount.multiply(factor.toString());
}

export interface MemberTotals {
  assets: Money;
  liabilities: Money;
  equity: Money;
  /** Cumulative income-statement result carried in the translated figures (natural: profit positive). */
  earnings: Money;
}

/**
 * Cumulative translation adjustment: whatever keeps the translated balance
 * sheet in balance once assets / liabilities are at the closing rate and the
 * period result at the average rate. Positive = credit (equity) balance.
 */
export function translationAdjustment(t: MemberTotals): Money {
  return t.assets.subtract(t.liabilities).subtract(t.equity).subtract(t.earnings);
}

/** Share of a FULL member's net assets and result that belongs to outside shareholders. */
export function nonControllingInterest(
  method: ConsolidationMethod,
  ownershipPct: string,
  netAssets: Money,
  earnings: Money,
  currency: string,
): { netAssets: Money; earnings: Money } {
  if (method !== 'FULL' || Number(ownershipPct) >= 100)
    return { netAssets: Money.zero(currency), earnings: Money.zero(currency) };
  const outside = ((100 - Number(ownershipPct)) / 100).toString();
  return { netAssets: netAssets.multiply(outside), earnings: earnings.multiply(outside) };
}

/** Month-end dates inside [from, to] (inclusive of `to`), used to average the closing rates. */
export function monthEndsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  let y = fy;
  let m = fm;
  for (;;) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (end > to) break;
    if (end >= from) out.push(end);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  if (out.length === 0 || out[out.length - 1] !== to) out.push(to);
  return out;
}

/** Arithmetic mean of decimal rate strings, 10 decimals. */
export function averageRate(rates: readonly string[]): string {
  if (rates.length === 0) return '1';
  const sum = rates.reduce((n, r) => n + Number(r), 0);
  return (sum / rates.length).toFixed(10);
}
