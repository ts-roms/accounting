import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, InvalidAmountError, Money } from './money';
import { formatMoney } from './format';

describe('Money', () => {
  it('avoids floating point drift', () => {
    const a = Money.of('0.1', 'PHP');
    const b = Money.of('0.2', 'PHP');
    expect(a.add(b).toString()).toBe('0.3000');
    expect(Money.of('1.005', 'PHP').multiply(100).toString()).toBe('100.5000');
  });

  it('rounds half-even to 4 decimals on construction', () => {
    expect(Money.of('1.00005', 'PHP').toString()).toBe('1.0000');
    expect(Money.of('1.00015', 'PHP').toString()).toBe('1.0002');
    expect(Money.of(12.5, 'PHP').toString()).toBe('12.5000');
  });

  it('parses strictly', () => {
    expect(Money.parse('1250.5', 'PHP').toString()).toBe('1250.5000');
    expect(() => Money.parse('1,250', 'PHP')).toThrow(InvalidAmountError);
    expect(() => Money.parse('1e3', 'PHP')).toThrow(InvalidAmountError);
    expect(() => Money.parse('1.23456', 'PHP')).toThrow(InvalidAmountError);
    expect(() => Money.of('abc', 'PHP')).toThrow(InvalidAmountError);
    expect(() => Money.of(Number.NaN, 'PHP')).toThrow(InvalidAmountError);
  });

  it('refuses cross-currency arithmetic', () => {
    expect(() => Money.of(1, 'PHP').add(Money.of(1, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('sums, compares and negates', () => {
    const total = Money.sum(
      [Money.of('10', 'PHP'), Money.of('2.25', 'PHP'), Money.of('-0.25', 'PHP')],
      'PHP',
    );
    expect(total.toString()).toBe('12.0000');
    expect(total.greaterThan(Money.of(11, 'PHP'))).toBe(true);
    expect(total.negate().isNegative()).toBe(true);
    expect(Money.zero('PHP').isZero()).toBe(true);
    expect(total.equals(Money.of('12', 'PHP'))).toBe(true);
  });

  it('allocates without losing minor units', () => {
    const parts = Money.of('100', 'PHP').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(Money.sum(parts, 'PHP').toString()).toBe('100.0000');
    const uneven = Money.of('0.0005', 'PHP').allocate([3, 7]);
    expect(Money.sum(uneven, 'PHP').toString()).toBe('0.0005');
  });

  it('serialises as a decimal string', () => {
    expect(JSON.stringify({ amount: Money.of('5', 'PHP') })).toBe('{"amount":"5.0000"}');
  });
});

describe('formatMoney', () => {
  it('formats with grouping, two decimals and accounting negatives', () => {
    expect(formatMoney('1234567.8912')).toBe('1,234,567.89');
    expect(formatMoney('-1234.5')).toBe('(1,234.50)');
    expect(formatMoney('-1234.5', 'PHP', { accounting: false })).toBe('-1,234.50');
    expect(formatMoney('0.0000')).toBe('0.00');
    expect(formatMoney('999.995')).toBe('1,000.00');
    expect(formatMoney(Money.of('12.3', 'USD'), 'PHP', { showCurrency: true })).toBe('USD 12.30');
  });
});

describe('Money.convert', () => {
  it('converts at an exact rate into the target currency, half-even at four places', () => {
    const usd = Money.of('100', 'USD');
    const php = usd.convert('PHP', '56.123456');
    expect(php.currency).toBe('PHP');
    expect(php.toString()).toBe('5612.3456');
    expect(Money.of('0.01', 'USD').convert('PHP', '56.12345').toString()).toBe('0.5612');
  });

  it('rejects non-positive rates', () => {
    expect(() => Money.of('1', 'USD').convert('PHP', '0')).toThrow();
  });
});

describe('Money.convert', () => {
  it('converts at an exact rate into the target currency, half-even at four places', () => {
    const usd = Money.of('100', 'USD');
    const php = usd.convert('PHP', '56.123456');
    expect(php.currency).toBe('PHP');
    expect(php.toString()).toBe('5612.3456');
    expect(Money.of('0.01', 'USD').convert('PHP', '56.12345').toString()).toBe('0.5612');
  });

  it('rejects non-positive rates', () => {
    expect(() => Money.of('1', 'USD').convert('PHP', '0')).toThrow();
  });
});
