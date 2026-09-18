import { Money } from '@accounting/money';
import type {
  LeaseClassification,
  LeasePaymentFrequency,
  LeasePaymentTiming,
} from '@accounting/types';

/*
 * Pure lease arithmetic (Prompt #13). No I/O, no dates from the clock: the
 * services feed terms in and persist what comes out. Keep it that way - the
 * unit spec pins the schedule shape and the rounding plug.
 *
 * Model (lessee, IFRS 16 / ASC 842 single model):
 *  - monthly compounding at annual rate / 12;
 *  - liability = present value of the payments not yet made at commencement;
 *  - right-of-use cost = liability + initial direct costs - incentives;
 *  - one schedule line per month: interest accretes on the liability carried
 *    into the month (after an in-advance payment), depreciation is straight
 *    line over the term, the payment falls on the months the frequency says;
 *  - rounding drift (each interest line is rounded to four places) is plugged
 *    into the last interest-bearing line so the liability ends at exactly 0.
 */

/** Intermediate arithmetic runs at 20 places; only the schedule figures are rounded to the currency scale. */
const WIDE = 20;
const wide = (amount: string | number | Money, currency: string) =>
  Money.of(amount, currency, WIDE);
const narrow = (amount: Money, currency: string) => Money.of(amount, currency);

export interface LeaseTerms {
  commencementDate: string;
  termMonths: number;
  paymentAmount: string;
  paymentFrequency: LeasePaymentFrequency;
  paymentTiming: LeasePaymentTiming;
  /** Annual rate in percent ("8", "7.25"). */
  annualDiscountRate: string;
  initialDirectCosts?: string;
  leaseIncentives?: string;
}

export interface LeaseScheduleLine {
  sequence: number;
  periodStart: string;
  periodEnd: string;
  openingLiability: string;
  payment: string;
  paymentDate: string | null;
  interest: string;
  depreciation: string;
  closingLiability: string;
}

export interface LeaseSchedule {
  /** Present value of the payments at the first period start. */
  initialLiability: string;
  /** Amount depreciated over the lines (liability + IDC - incentives unless overridden). */
  rouCost: string;
  totalPayments: string;
  totalInterest: string;
  lines: LeaseScheduleLine[];
}

export interface BuildOptions {
  /** Sequence number of the first line (remeasurement continues an existing schedule). */
  firstSequence?: number;
  /** Depreciate this carrying amount over the lines instead of liability + IDC - incentives. */
  rouCarrying?: string;
  /** Exempt leases: payments only, no liability / interest / depreciation. */
  exempt?: boolean;
}

export const FREQUENCY_MONTHS: Record<LeasePaymentFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  ANNUAL: 12,
};

// ------------------------------------------------------------------- dates

const pad = (n: number) => String(n).padStart(2, '0');

function parts(iso: string): { y: number; m: number; d: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Same day of month `n` months later, clamped to the month length (Jan 31 + 1 -> Feb 28/29). */
export function addMonths(iso: string, n: number): string {
  const { y, m, d } = parts(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

export function addDays(iso: string, n: number): string {
  const { y, m, d } = parts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// --------------------------------------------------------------- arithmetic

/** Monthly rate as a decimal fraction string: annual percent / 100 / 12 (20 places). */
export function monthlyRate(annualPercent: string): string {
  return wide(annualPercent, 'RATE').divide(1200).toString();
}

/** Month offsets (from the first period start) on which a payment falls. */
export function paymentMonths(
  termMonths: number,
  frequency: LeasePaymentFrequency,
  timing: LeasePaymentTiming,
): number[] {
  const step = FREQUENCY_MONTHS[frequency];
  const out: number[] = [];
  for (let k = 0; k < termMonths; k += step) out.push(timing === 'IN_ADVANCE' ? k : k + step);
  return out;
}

/**
 * Present value of level payments at the monthly rate. In advance: the first
 * payment is at month 0 (undiscounted); in arrears: at the end of each period.
 */
export function presentValue(
  payment: string,
  termMonths: number,
  frequency: LeasePaymentFrequency,
  timing: LeasePaymentTiming,
  annualPercent: string,
  currency: string,
): Money {
  const onePlusR = wide(1, currency)
    .add(wide(monthlyRate(annualPercent), currency))
    .toString();
  const p = wide(payment, currency);
  const months = paymentMonths(termMonths, frequency, timing);
  const last = months[months.length - 1] ?? 0;
  // Running discount factor 1 / (1 + r)^m, one division per month.
  const factors: Money[] = [wide(1, currency)];
  for (let m = 1; m <= last; m += 1) factors.push(factors[m - 1]!.divide(onePlusR));
  let pv = wide(0, currency);
  for (const m of months) pv = pv.add(p.multiply(factors[m]!.toString()));
  return narrow(pv, currency);
}

/** Classification from the thresholds; an override always wins. */
export function classify(
  input: {
    termMonths: number;
    underlyingAssetValue?: string | null;
    classificationOverride?: LeaseClassification | null;
  },
  settings: { shortTermThresholdMonths: number; lowValueThreshold: string },
): LeaseClassification {
  if (input.classificationOverride) return input.classificationOverride;
  if (input.termMonths <= settings.shortTermThresholdMonths) return 'SHORT_TERM';
  const threshold = Money.of(settings.lowValueThreshold, 'VALUE');
  if (
    threshold.isPositive() &&
    input.underlyingAssetValue !== undefined &&
    input.underlyingAssetValue !== null &&
    !Money.of(input.underlyingAssetValue, 'VALUE').greaterThan(threshold)
  )
    return 'LOW_VALUE';
  return 'FINANCE';
}

/**
 * The monthly schedule for a set of terms. Exempt leases get payment lines
 * only. The rounding plug keeps the liability at exactly zero after the last
 * line without changing any payment.
 */
export function buildLeaseSchedule(
  terms: LeaseTerms,
  currency: string,
  options: BuildOptions = {},
): LeaseSchedule {
  const n = terms.termMonths;
  if (n <= 0) throw new Error('termMonths must be positive');
  const step = FREQUENCY_MONTHS[terms.paymentFrequency];
  if (n % step !== 0) throw new Error('termMonths must be a whole number of payment periods');
  const first = options.firstSequence ?? 1;
  const payment = Money.of(terms.paymentAmount, currency);
  const zero = Money.zero(currency);
  const payMonths = new Set(paymentMonths(n, terms.paymentFrequency, terms.paymentTiming));
  const advance = terms.paymentTiming === 'IN_ADVANCE';

  const periods = Array.from({ length: n }, (_, k) => {
    const start = addMonths(terms.commencementDate, k);
    const end = addDays(addMonths(terms.commencementDate, k + 1), -1);
    const pays = advance ? payMonths.has(k) : payMonths.has(k + 1);
    return { k, start, end, pays, paymentDate: pays ? (advance ? start : end) : null };
  });
  const totalPayments = payment.multiply(periods.filter((p) => p.pays).length);

  if (options.exempt) {
    return {
      initialLiability: zero.toString(),
      rouCost: zero.toString(),
      totalPayments: totalPayments.toString(),
      totalInterest: zero.toString(),
      lines: periods.map((p, i) => ({
        sequence: first + i,
        periodStart: p.start,
        periodEnd: p.end,
        openingLiability: zero.toString(),
        payment: p.pays ? payment.toString() : zero.toString(),
        paymentDate: p.paymentDate,
        interest: zero.toString(),
        depreciation: zero.toString(),
        closingLiability: zero.toString(),
      })),
    };
  }

  const liability = presentValue(
    terms.paymentAmount,
    n,
    terms.paymentFrequency,
    terms.paymentTiming,
    terms.annualDiscountRate,
    currency,
  );
  const rouCost = options.rouCarrying
    ? Money.of(options.rouCarrying, currency)
    : liability
        .add(Money.of(terms.initialDirectCosts ?? '0', currency))
        .subtract(Money.of(terms.leaseIncentives ?? '0', currency));
  const depreciation = rouCost.isZero()
    ? periods.map(() => zero)
    : rouCost.allocate(periods.map(() => 1));
  const r = monthlyRate(terms.annualDiscountRate);

  const compute = (plugIndex: number, plug: Money) => {
    let balance = liability;
    const lines: LeaseScheduleLine[] = [];
    for (const p of periods) {
      const opening = balance;
      if (advance && p.pays) balance = balance.subtract(payment);
      let interest = balance.multiply(r);
      if (interest.isNegative()) interest = zero;
      if (p.k === plugIndex) interest = interest.subtract(plug);
      balance = balance.add(interest);
      if (!advance && p.pays) balance = balance.subtract(payment);
      lines.push({
        sequence: first + p.k,
        periodStart: p.start,
        periodEnd: p.end,
        openingLiability: opening.toString(),
        payment: p.pays ? payment.toString() : zero.toString(),
        paymentDate: p.paymentDate,
        interest: interest.toString(),
        depreciation: depreciation[p.k]!.toString(),
        closingLiability: balance.toString(),
      });
    }
    return { lines, residual: balance };
  };

  const firstPass = compute(-1, zero);
  let lines = firstPass.lines;
  if (!firstPass.residual.isZero()) {
    // Plug the drift into the last line that carries interest (never a payment).
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1)
      if (!Money.of(lines[i]!.interest, currency).isZero()) {
        idx = i;
        break;
      }
    if (idx >= 0) lines = compute(idx, firstPass.residual).lines;
  }
  const totalInterest = Money.sum(
    lines.map((l) => Money.of(l.interest, currency)),
    currency,
  );
  return {
    initialLiability: liability.toString(),
    rouCost: rouCost.toString(),
    totalPayments: totalPayments.toString(),
    totalInterest: totalInterest.toString(),
    lines,
  };
}

/** Undiscounted payments still to be made, bucketed: next 12 months then per year. */
export function maturityBuckets(
  lines: ReadonlyArray<{ payment: string; paymentDate: string | null; paid: boolean }>,
  asOf: string,
  years: number,
  currency: string,
): Array<{ label: string; from: string; to: string; amount: string }> {
  const buckets: Array<{ label: string; from: string; to: string; amount: Money }> = [];
  let from = asOf;
  for (let y = 0; y <= years; y += 1) {
    const to = addDays(addMonths(asOf, 12 * (y + 1)), -1);
    buckets.push({
      label: y === 0 ? 'Within 1 year' : `Year ${y + 1}`,
      from,
      to,
      amount: Money.zero(currency),
    });
    from = addMonths(asOf, 12 * (y + 1));
  }
  const last = buckets[buckets.length - 1]!;
  for (const line of lines) {
    if (line.paid || !line.paymentDate) continue;
    const amount = Money.of(line.payment, currency);
    if (amount.isZero()) continue;
    const date = line.paymentDate < asOf ? asOf : line.paymentDate;
    const bucket = buckets.find((b) => date >= b.from && date <= b.to) ?? last;
    bucket.amount = bucket.amount.add(amount);
  }
  return buckets.map((b) => ({ ...b, amount: b.amount.toString() }));
}

/**
 * Base-currency amounts for a series of contract-currency amounts converted at
 * one historical rate: each line is converted and rounded on its own, and the
 * rounding drift is plugged into the last non-zero line so the series sums to
 * exactly `total.convert(rate)` (the right-of-use base cost, for depreciation).
 */
export function convertSeriesAtRate(
  amounts: readonly string[],
  currency: string,
  baseCurrency: string,
  rate: string,
): string[] {
  const total = wide(
    amounts.reduce((acc, a) => acc.add(wide(a, currency)), wide(0, currency)),
    currency,
  ).convert(baseCurrency, rate);
  const target = narrow(total, baseCurrency);
  const converted = amounts.map((a) => Money.of(a, currency).convert(baseCurrency, rate));
  const sum = converted.reduce((acc, m) => acc.add(m), Money.zero(baseCurrency));
  const drift = target.subtract(sum);
  if (!drift.isZero()) {
    let last = converted.length - 1;
    while (last > 0 && converted[last]!.isZero()) last -= 1;
    converted[last] = converted[last]!.add(drift);
  }
  return converted.map((m) => m.toString());
}

/**
 * Base carrying amount relieved when `payment` (contract currency) settles part
 * of a liability carried at `liabilityBase` for `liability` units: the payment's
 * share of the carrying base, and the whole of it when the payment clears the
 * liability so no rounding residue is left behind.
 */
export function baseRelieved(liability: Money, liabilityBase: Money, payment: Money): Money {
  if (liability.isZero() || payment.greaterThan(liability) || payment.equals(liability))
    return liabilityBase;
  const share = wide(liabilityBase, liabilityBase.currency)
    .multiply(payment.toString())
    .divide(liability.toString());
  return narrow(share, liabilityBase.currency);
}
