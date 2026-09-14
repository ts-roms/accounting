import { Money } from '@accounting/money';
import { invertRate, pickRate, realizedFx } from './fx.logic';

describe('fx.logic', () => {
  const rows = [
    { fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-01-01', rate: '56.00000000' },
    { fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-03-01', rate: '57.50000000' },
    { fromCurrency: 'PHP', toCurrency: 'EUR', rateDate: '2026-02-01', rate: '0.01600000' },
  ];

  it('picks the latest quote on or before the date, or the inverse of the reverse pair', () => {
    expect(pickRate(rows, 'USD', 'PHP', '2026-02-15')).toBe('56.00000000');
    expect(pickRate(rows, 'USD', 'PHP', '2026-03-01')).toBe('57.50000000');
    expect(pickRate(rows, 'USD', 'PHP', '2025-12-31')).toBeNull();
    expect(pickRate(rows, 'EUR', 'PHP', '2026-06-01')).toBe('62.50000000');
    expect(pickRate(rows, 'PHP', 'PHP', '2026-06-01')).toBe('1');
  });

  it('inverts at eight decimals', () => {
    expect(invertRate('56')).toBe('0.01785714');
  });

  it('signs realized FX from the company view per side', () => {
    const usd = Money.of('1000', 'USD');
    expect(realizedFx(usd, '56', '57.5', 'PHP', 'AR').toString()).toBe('1500.0000'); // received more base
    expect(realizedFx(usd, '56', '57.5', 'PHP', 'AP').toString()).toBe('-1500.0000'); // paid more base
    expect(realizedFx(usd, '56', '56', 'PHP', 'AR').isZero()).toBe(true);
  });
});
