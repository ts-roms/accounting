import { Money } from '@accounting/money';
import {
  averageRate,
  monthEndsBetween,
  naturalBalance,
  nonControllingInterest,
  ownershipFactor,
  scale,
  translate,
  translationAdjustment,
} from './group-consolidation.logic';

const usd = (v: string) => Money.of(v, 'USD');
const php = (v: string) => Money.of(v, 'PHP');

describe('group consolidation logic', () => {
  it('presents natural balances per account type', () => {
    expect(naturalBalance('ASSET', php('100'), php('30')).toString()).toBe('70.0000');
    expect(naturalBalance('LIABILITY', php('30'), php('100')).toString()).toBe('70.0000');
    expect(naturalBalance('REVENUE', php('0'), php('500')).toString()).toBe('500.0000');
    expect(naturalBalance('OTHER_EXPENSE', php('40'), php('0')).toString()).toBe('40.0000');
  });

  it('translates balance-sheet items at closing and P&L at average', () => {
    const rates = { closing: '56', average: '55' };
    expect(translate('ASSET', usd('100'), rates, 'PHP').toString()).toBe('5600.0000');
    expect(translate('EQUITY', usd('100'), rates, 'PHP').toString()).toBe('5600.0000');
    expect(translate('REVENUE', usd('100'), rates, 'PHP').toString()).toBe('5500.0000');
  });

  it('the CTA plug closes the translated balance sheet', () => {
    // Assets 1,000 USD, liabilities 400, equity 500, earnings 100 in USD -> balanced in USD.
    const rates = { closing: '56', average: '55' };
    const totals = {
      assets: translate('ASSET', usd('1000'), rates, 'PHP'),
      liabilities: translate('LIABILITY', usd('400'), rates, 'PHP'),
      equity: translate('EQUITY', usd('500'), rates, 'PHP'),
      earnings: translate('REVENUE', usd('100'), rates, 'PHP'),
    };
    const cta = translationAdjustment(totals);
    // 100 USD of earnings at 55 instead of 56 leaves 100 PHP to plug.
    expect(cta.toString()).toBe('100.0000');
    expect(
      totals.assets
        .subtract(totals.liabilities)
        .subtract(totals.equity)
        .subtract(totals.earnings)
        .subtract(cta)
        .isZero(),
    ).toBe(true);
  });

  it('scales proportionate members and derives NCI for full members below 100%', () => {
    expect(ownershipFactor('FULL', '60')).toBe(1);
    expect(ownershipFactor('PROPORTIONATE', '60')).toBe(0.6);
    expect(scale(php('1000'), 0.6).toString()).toBe('600.0000');
    const nci = nonControllingInterest('FULL', '60', php('1000'), php('200'), 'PHP');
    expect(nci.netAssets.toString()).toBe('400.0000');
    expect(nci.earnings.toString()).toBe('80.0000');
    expect(
      nonControllingInterest('FULL', '100', php('1000'), php('200'), 'PHP').netAssets.isZero(),
    ).toBe(true);
    expect(
      nonControllingInterest(
        'PROPORTIONATE',
        '60',
        php('1000'),
        php('200'),
        'PHP',
      ).netAssets.isZero(),
    ).toBe(true);
  });

  it('samples month ends for the average rate and averages decimal strings', () => {
    expect(monthEndsBetween('2026-01-01', '2026-03-31')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
    expect(monthEndsBetween('2026-09-01', '2026-09-15')).toEqual(['2026-09-15']);
    expect(monthEndsBetween('2026-11-15', '2027-01-10')).toEqual([
      '2026-11-30',
      '2026-12-31',
      '2027-01-10',
    ]);
    expect(averageRate(['56', '55', '54'])).toBe('55.0000000000');
    expect(averageRate([])).toBe('1');
  });
});
