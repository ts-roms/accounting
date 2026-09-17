import { Money } from '@accounting/money';
import {
  addMonths,
  buildLeaseSchedule,
  classify,
  maturityBuckets,
  paymentMonths,
  presentValue,
} from './lease.logic';

const PHP = 'PHP';

describe('lease.logic', () => {
  it('adds months with day clamping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-05-01', 36)).toBe('2029-05-01');
  });

  it('places payments by frequency and timing', () => {
    expect(paymentMonths(6, 'MONTHLY', 'IN_ADVANCE')).toEqual([0, 1, 2, 3, 4, 5]);
    expect(paymentMonths(6, 'MONTHLY', 'IN_ARREARS')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(paymentMonths(12, 'QUARTERLY', 'IN_ADVANCE')).toEqual([0, 3, 6, 9]);
    expect(paymentMonths(24, 'ANNUAL', 'IN_ARREARS')).toEqual([12, 24]);
  });

  it('discounts level payments at the monthly rate', () => {
    // 12 x 10,000 in arrears at 12% p.a. (1% per month): annuity factor 11.2551
    expect(presentValue('10000', 12, 'MONTHLY', 'IN_ARREARS', '12', PHP).toString()).toBe(
      '112550.7747',
    );
    // In advance the first payment is undiscounted: factor 11.3676
    expect(presentValue('10000', 12, 'MONTHLY', 'IN_ADVANCE', '12', PHP).toString()).toBe(
      '113676.2825',
    );
    // Zero rate: the plain sum.
    expect(presentValue('10000', 12, 'MONTHLY', 'IN_ADVANCE', '0', PHP).toString()).toBe(
      '120000.0000',
    );
  });

  it('classifies by thresholds unless overridden', () => {
    const settings = { shortTermThresholdMonths: 12, lowValueThreshold: '250000' };
    expect(classify({ termMonths: 6 }, settings)).toBe('SHORT_TERM');
    expect(classify({ termMonths: 36, underlyingAssetValue: '120000' }, settings)).toBe(
      'LOW_VALUE',
    );
    expect(classify({ termMonths: 36, underlyingAssetValue: '900000' }, settings)).toBe('FINANCE');
    expect(classify({ termMonths: 36 }, settings)).toBe('FINANCE');
    expect(classify({ termMonths: 6, classificationOverride: 'FINANCE' }, settings)).toBe(
      'FINANCE',
    );
    expect(
      classify(
        { termMonths: 36, underlyingAssetValue: '1' },
        { ...settings, lowValueThreshold: '0' },
      ),
    ).toBe('FINANCE');
  });

  it('builds a schedule whose liability amortises to exactly zero', () => {
    const s = buildLeaseSchedule(
      {
        commencementDate: '2026-05-01',
        termMonths: 36,
        paymentAmount: '45000',
        paymentFrequency: 'MONTHLY',
        paymentTiming: 'IN_ADVANCE',
        annualDiscountRate: '8',
        initialDirectCosts: '12000',
        leaseIncentives: '0',
      },
      PHP,
    );
    expect(s.lines).toHaveLength(36);
    expect(s.initialLiability).toBe(
      presentValue('45000', 36, 'MONTHLY', 'IN_ADVANCE', '8', PHP).toString(),
    );
    expect(
      Money.of(s.rouCost, PHP).equals(
        Money.of(s.initialLiability, PHP).add(Money.of('12000', PHP)),
      ),
    ).toBe(true);
    const first = s.lines[0]!;
    expect(first.periodStart).toBe('2026-05-01');
    expect(first.periodEnd).toBe('2026-05-31');
    expect(first.paymentDate).toBe('2026-05-01');
    expect(first.openingLiability).toBe(s.initialLiability);
    // Interest accrues on the balance after the in-advance payment.
    const afterPay = Money.of(s.initialLiability, PHP).subtract(Money.of('45000', PHP));
    expect(first.interest).toBe(afterPay.multiply(0.08 / 12).toString());
    const last = s.lines[35]!;
    expect(last.closingLiability).toBe('0.0000');
    expect(last.paymentDate).toBe('2029-04-01');
    // Depreciation is straight line over the term and sums to the ROU cost.
    const dep = Money.sum(
      s.lines.map((l) => Money.of(l.depreciation, PHP)),
      PHP,
    );
    expect(dep.toString()).toBe(s.rouCost);
    // Payments + interest reconcile: total payments = liability + total interest.
    expect(
      Money.of(s.totalPayments, PHP).equals(
        Money.of(s.initialLiability, PHP).add(Money.of(s.totalInterest, PHP)),
      ),
    ).toBe(true);
    // Every line chains.
    for (let i = 1; i < s.lines.length; i += 1)
      expect(s.lines[i]!.openingLiability).toBe(s.lines[i - 1]!.closingLiability);
    // No negative interest anywhere.
    expect(s.lines.every((l) => !Money.of(l.interest, PHP).isNegative())).toBe(true);
  });

  it('handles quarterly payments in arrears', () => {
    const s = buildLeaseSchedule(
      {
        commencementDate: '2026-01-01',
        termMonths: 24,
        paymentAmount: '90000',
        paymentFrequency: 'QUARTERLY',
        paymentTiming: 'IN_ARREARS',
        annualDiscountRate: '10',
      },
      PHP,
    );
    expect(s.lines.filter((l) => l.payment !== '0.0000')).toHaveLength(8);
    expect(s.lines[2]!.paymentDate).toBe('2026-03-31');
    expect(s.lines[0]!.payment).toBe('0.0000');
    expect(s.lines[23]!.closingLiability).toBe('0.0000');
    expect(s.totalPayments).toBe('720000.0000');
  });

  it('continues a schedule for a remeasurement with a carrying amount', () => {
    const s = buildLeaseSchedule(
      {
        commencementDate: '2027-05-01',
        termMonths: 12,
        paymentAmount: '50000',
        paymentFrequency: 'MONTHLY',
        paymentTiming: 'IN_ADVANCE',
        annualDiscountRate: '8',
      },
      PHP,
      { firstSequence: 13, rouCarrying: '480000' },
    );
    expect(s.lines[0]!.sequence).toBe(13);
    expect(s.rouCost).toBe('480000.0000');
    expect(s.lines[0]!.depreciation).toBe('40000.0000');
    expect(s.lines[11]!.closingLiability).toBe('0.0000');
  });

  it('gives exempt leases payment lines only', () => {
    const s = buildLeaseSchedule(
      {
        commencementDate: '2026-06-01',
        termMonths: 6,
        paymentAmount: '8000',
        paymentFrequency: 'MONTHLY',
        paymentTiming: 'IN_ADVANCE',
        annualDiscountRate: '8',
      },
      PHP,
      { exempt: true },
    );
    expect(s.initialLiability).toBe('0.0000');
    expect(s.rouCost).toBe('0.0000');
    expect(s.lines.every((l) => l.interest === '0.0000' && l.depreciation === '0.0000')).toBe(true);
    expect(s.totalPayments).toBe('48000.0000');
  });

  it('buckets unpaid payments by maturity', () => {
    const buckets = maturityBuckets(
      [
        { payment: '100', paymentDate: '2026-03-01', paid: true },
        { payment: '100', paymentDate: '2026-08-01', paid: false }, // overdue -> first bucket
        { payment: '100', paymentDate: '2027-01-01', paid: false },
        { payment: '100', paymentDate: '2028-01-01', paid: false },
        { payment: '100', paymentDate: '2040-01-01', paid: false }, // beyond horizon -> last
      ],
      '2026-09-30',
      2,
      PHP,
    );
    expect(buckets.map((b) => b.amount)).toEqual(['200.0000', '100.0000', '100.0000']);
    expect(buckets[0]!.to).toBe('2027-09-29');
  });
});
