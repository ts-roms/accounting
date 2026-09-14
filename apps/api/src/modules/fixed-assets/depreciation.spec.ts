import { Money } from '@accounting/money';
import { disposalGainLoss, monthlyDepreciation, schedule } from './depreciation';

const PHP = 'PHP';
const base = {
  cost: '120000.0000',
  salvageValue: '0.0000',
  accumulatedDepreciation: '0.0000',
  usefulLifeMonths: 36,
  depreciatedMonths: 0,
  depreciationMethod: 'STRAIGHT_LINE' as const,
  decliningRatePercent: null,
};

describe('depreciation', () => {
  it('straight line spreads cost - salvage evenly and lands exactly on salvage', () => {
    const s = schedule({ ...base, cost: '100000.0000', salvageValue: '1000.0000', usefulLifeMonths: 7 }, PHP);
    expect(s).toHaveLength(7);
    expect(s[0]!.toString()).toBe('14142.8571');
    expect(Money.sum(s, PHP).toString()).toBe('99000.0000');
    // The schedule re-divides the remaining amount each month, so no residue is left at the end.
    expect(s.every((m) => m.toString().startsWith('14142.857'))).toBe(true);
  });

  it('impairment shortens the remaining schedule rather than the monthly rate', () => {
    // 36 months, 12 taken (40,000), then impaired by 20,000: 60,000 left over 24 months.
    const amount = monthlyDepreciation({ ...base, accumulatedDepreciation: '60000.0000', depreciatedMonths: 12 }, PHP);
    expect(amount.toString()).toBe('2500.0000');
  });

  it('declining balance applies the annual rate to book value and never breaches salvage', () => {
    const asset = { ...base, depreciationMethod: 'DECLINING_BALANCE' as const, decliningRatePercent: '40', salvageValue: '10000.0000' };
    const first = monthlyDepreciation(asset, PHP);
    expect(first.toString()).toBe('4000.0000'); // 120,000 x 40% / 12
    const s = schedule(asset, PHP);
    expect(Money.sum(s, PHP).toString()).toBe('110000.0000');
    expect(s.length).toBeLessThanOrEqual(36);
  });

  it('fully depreciated assets stop; disposal gain / loss is proceeds less book value', () => {
    expect(monthlyDepreciation({ ...base, accumulatedDepreciation: '120000.0000', depreciatedMonths: 36 }, PHP).isZero()).toBe(true);
    expect(disposalGainLoss({ cost: '120000', accumulatedDepreciation: '80000' }, '50000', PHP).toString()).toBe('10000.0000');
    expect(disposalGainLoss({ cost: '120000', accumulatedDepreciation: '80000' }, '0', PHP).toString()).toBe('-40000.0000');
  });
});
