import { Money } from '@accounting/money';

/** Pure exchange-rate arithmetic. */

export interface RateRow {
  fromCurrency: string;
  toCurrency: string;
  rateDate: string;
  rate: string;
}

const SCALE = 8;

/** 1 / rate at eight decimals, half-even. */
export function invertRate(rate: string): string {
  const r = Money.of('1', 'RATE', SCALE).divide(rate);
  return r.toString();
}

/**
 * The rate in force on `onDate`: the latest direct quote on or before the date,
 * else the inverse of the latest reverse quote. Same currency = 1.
 */
export function pickRate(
  rows: readonly RateRow[],
  from: string,
  to: string,
  onDate: string,
): string | null {
  if (from === to) return '1';
  const latest = (f: string, t: string) =>
    rows
      .filter((r) => r.fromCurrency === f && r.toCurrency === t && r.rateDate <= onDate)
      .sort((a, b) => (a.rateDate < b.rateDate ? 1 : a.rateDate > b.rateDate ? -1 : 0))[0] ?? null;
  const direct = latest(from, to);
  if (direct) return direct.rate;
  const reverse = latest(to, from);
  return reverse ? invertRate(reverse.rate) : null;
}

/**
 * Realized FX on settling `amount` (document currency) that was booked at
 * `documentRate` and is now settled at `settlementRate`. Returns the signed
 * base-currency gain (positive) or loss (negative) from the company's view.
 * Receivables: settling at a higher rate brings in more base = gain.
 * Payables: settling at a higher rate costs more base = loss.
 */
export function realizedFx(
  amount: Money,
  documentRate: string,
  settlementRate: string,
  baseCurrency: string,
  side: 'AR' | 'AP',
): Money {
  const atDocument = amount.convert(baseCurrency, documentRate);
  const atSettlement = amount.convert(baseCurrency, settlementRate);
  const diff = atSettlement.subtract(atDocument);
  return side === 'AR' ? diff : diff.negate();
}
