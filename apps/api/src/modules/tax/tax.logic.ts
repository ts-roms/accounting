import { Money } from '@accounting/money';

/** Pure tax arithmetic. Rates are percentages as decimal strings ("12", "1.5"). */

export interface EffectiveRate {
  ratePercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** The rate in force on a date, or null when none covers it. */
export function resolveRate<R extends EffectiveRate>(rates: readonly R[], onDate: string): R | null {
  const covering = rates.filter(
    (r) => r.effectiveFrom <= onDate && (r.effectiveTo === null || r.effectiveTo >= onDate),
  );
  if (covering.length === 0) return null;
  // Latest start wins when histories overlap.
  return covering.reduce((best, r) => (r.effectiveFrom > best.effectiveFrom ? r : best));
}

/** Tax added on top of a net base: base x rate%, half-even to the currency scale. */
export function taxOn(base: Money, ratePercent: string): Money {
  return base.multiply(ratePercent).multiply('0.01');
}

/**
 * Splits a tax-inclusive gross amount into base and tax:
 * tax = gross - gross / (1 + rate%), so base + tax always equals the gross exactly.
 */
export function extractInclusiveTax(gross: Money, ratePercent: string): { base: Money; tax: Money } {
  const divisor = Money.of('1', gross.currency).add(Money.of(ratePercent, gross.currency).multiply('0.01'));
  const base = gross.divide(divisor.toString());
  return { base, tax: gross.subtract(base) };
}
