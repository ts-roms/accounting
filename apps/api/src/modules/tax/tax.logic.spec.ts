import { Money } from '@accounting/money';
import { extractInclusiveTax, resolveRate, taxOn } from './tax.logic';

describe('tax.logic', () => {
  const rates = [
    { ratePercent: '10', effectiveFrom: '2020-01-01', effectiveTo: '2025-12-31' },
    { ratePercent: '12', effectiveFrom: '2026-01-01', effectiveTo: null },
  ];

  it('resolves the rate in force on a date and null outside every window', () => {
    expect(resolveRate(rates, '2025-06-30')?.ratePercent).toBe('10');
    expect(resolveRate(rates, '2026-01-01')?.ratePercent).toBe('12');
    expect(resolveRate(rates, '2019-12-31')).toBeNull();
  });

  it('adds tax on a net base half-even at four places', () => {
    expect(taxOn(Money.of('10000', 'PHP'), '12').toString()).toBe('1200.0000');
    expect(taxOn(Money.of('333.3333', 'PHP'), '12').toString()).toBe('40.0000');
    expect(taxOn(Money.of('0.0125', 'PHP'), '12').toString()).toBe('0.0015');
  });

  it('splits a tax-inclusive gross so base + tax equals the gross exactly', () => {
    const { base, tax } = extractInclusiveTax(Money.of('1120', 'PHP'), '12');
    expect(base.toString()).toBe('1000.0000');
    expect(tax.toString()).toBe('120.0000');
    const odd = extractInclusiveTax(Money.of('999.99', 'PHP'), '12');
    expect(odd.base.add(odd.tax).toString()).toBe('999.9900');
    const zero = extractInclusiveTax(Money.of('500', 'PHP'), '0');
    expect(zero.tax.isZero()).toBe(true);
  });
});
