import type { ConsolidationGroupAccounts } from '@accounting/types';
import {
  adjustmentTotals,
  averageRate,
  consolidate,
  nciShareOfProfit,
  runEngine,
  translateMember,
  type ChartEntry,
  type MemberInput,
  type StoredAdjustmentLine,
} from './consolidation.logic';

const PHP = 'PHP';
const ACCOUNTS: ConsolidationGroupAccounts = {
  cumulativeTranslationAdjustment: '3500',
  nonControllingInterest: '3400',
  goodwill: '1710',
  retainedEarnings: '3200',
  intercompanyDifference: '6980',
  shareOfAssociateProfit: '4950',
  investment: '1700',
};
const chart = new Map<string, ChartEntry>([
  ['1130', { name: 'Cash', type: 'ASSET', subtype: 'BANK' }],
  ['1290', { name: 'Due from affiliates', type: 'ASSET', subtype: 'OTHER_ASSET' }],
  ['1700', { name: 'Investment in subsidiaries', type: 'ASSET', subtype: 'OTHER_ASSET' }],
  ['1710', { name: 'Goodwill', type: 'ASSET', subtype: 'OTHER_ASSET' }],
  ['2180', { name: 'Due to affiliates', type: 'LIABILITY', subtype: 'OTHER_LIABILITY' }],
  ['3100', { name: 'Share capital', type: 'EQUITY', subtype: 'SHARE_CAPITAL' }],
  ['3200', { name: 'Retained earnings', type: 'EQUITY', subtype: 'RETAINED_EARNINGS' }],
  ['3400', { name: 'Non-controlling interest', type: 'EQUITY', subtype: 'OTHER_EQUITY' }],
  ['3500', { name: 'CTA', type: 'EQUITY', subtype: 'OTHER_EQUITY' }],
  ['4200', { name: 'Service revenue', type: 'REVENUE', subtype: 'SALES' }],
  ['4950', { name: 'Share of associate profit', type: 'OTHER_INCOME', subtype: 'OTHER_INCOME' }],
  ['6700', { name: 'Professional fees', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' }],
  ['6980', { name: 'Intercompany difference', type: 'EXPENSE', subtype: 'OTHER_EXPENSE' }],
]);
const rates = { closing: '1', average: '1', historical: '1', opening: '1' };
const row = (code: string, closing: string, period = '0', isIntercompany = false) => {
  const c = chart.get(code)!;
  return {
    code,
    name: c.name,
    type: c.type,
    subtype: c.subtype,
    isIntercompany,
    closing,
    opening: '0',
    period,
  };
};

/** Parent (100%) with an 80% subsidiary bought for 180,000 when its equity was 200,000. */
const parent: MemberInput = {
  companyId: 'P',
  code: 'ACME',
  name: 'Acme',
  currency: PHP,
  method: 'FULL',
  ownershipPercent: '100',
  isParent: true,
  acquisitionEquity: '0',
  investmentCost: '0',
  rates,
  rows: [
    row('1130', '820000'),
    row('1700', '180000'),
    row('2180', '60000', '0', true),
    row('3100', '1000000'),
    row('6700', '60000', '60000'),
  ],
};
const sub: MemberInput = {
  companyId: 'S',
  code: 'ACMS',
  name: 'Acme Services',
  currency: PHP,
  method: 'FULL',
  ownershipPercent: '80',
  isParent: false,
  acquisitionEquity: '200000',
  investmentCost: '180000',
  rates,
  rows: [
    row('1130', '300000'),
    row('1290', '60000', '0', true),
    row('3100', '200000'),
    row('4200', '160000', '160000'),
  ],
};

describe('translateMember', () => {
  it('translates at closing / average / historical rates and plugs the difference to CTA', () => {
    const usd: MemberInput = {
      ...sub,
      currency: 'USD',
      rates: { closing: '57.5', average: '56.5', historical: '56', opening: '56' },
      rows: [row('1130', '1000'), row('3100', '800'), row('4200', '200', '200')],
    };
    const t = translateMember(usd, 'CURRENT_RATE', PHP, ACCOUNTS);
    const by = Object.fromEntries(t.rows.map((r) => [r.code, r.amount.toString()]));
    expect(by['1130']).toBe('57500.0000'); // closing
    expect(by['3100']).toBe('44800.0000'); // historical
    expect(by['4200']).toBe('11300.0000'); // average
    expect(by['3500']).toBe('1400.0000'); // 57,500 - 44,800 - 11,300
    expect(t.translationAdjustment.toString()).toBe('1400.0000');
    expect(t.netIncome.toString()).toBe('11300.0000');
    const closingOnly = translateMember(usd, 'CLOSING_RATE', PHP, ACCOUNTS);
    expect(closingOnly.translationAdjustment.isZero()).toBe(true);
  });
  it('scales a proportionally consolidated member by its ownership', () => {
    const t = translateMember(
      { ...sub, method: 'PROPORTIONAL', ownershipPercent: '40' },
      'CLOSING_RATE',
      PHP,
      ACCOUNTS,
    );
    expect(t.rows.find((r) => r.code === '1130')!.amount.toString()).toBe('120000.0000');
  });
});

describe('runEngine + consolidate', () => {
  const rules = [
    { id: 'r1', code: 'IC-BAL', type: 'INTERCOMPANY_BALANCES' as const, config: {} },
    {
      id: 'r2',
      code: 'IC-PL',
      type: 'INTERCOMPANY_PROFIT_LOSS' as const,
      config: { revenueCodes: ['4200'], expenseCodes: ['6700'] },
    },
    { id: 'r3', code: 'INV', type: 'INVESTMENT_EQUITY' as const, config: {} },
  ];
  it('eliminates intercompany balances and P&L, the investment against equity, books goodwill and NCI, and balances', () => {
    const out = runEngine({
      currency: PHP,
      translationMethod: 'CURRENT_RATE',
      accounts: ACCOUNTS,
      members: [parent, sub],
      rules,
      chart,
    });
    // No post-acquisition reserves yet (share capital only), so no NCI reserves entry; the current-year share is an allocation.
    expect(out.adjustments.map((a) => a.type)).toEqual([
      'ELIMINATION',
      'ELIMINATION',
      'ELIMINATION',
    ]);
    for (const a of out.adjustments) expect(adjustmentTotals(a.lines, PHP).balanced).toBe(true);
    const inv = out.adjustments[2]!;
    const find = (code: string) => inv.lines.find((l) => l.accountCode === code)!;
    expect(find('3100').debit).toBe('200000.0000');
    expect(find('1700').credit).toBe('180000.0000');
    expect(find('3400').credit).toBe('40000.0000'); // 20% of 200,000
    expect(find('1710').debit).toBe('20000.0000'); // 180,000 - 80% x 200,000
    const lines: StoredAdjustmentLine[] = out.adjustments.flatMap((a) => a.lines);
    const tb = consolidate(out.translated, lines, PHP, ACCOUNTS, chart);
    const r = (code: string) => tb.rows.find((x) => x.code === code);
    expect(r('1290')?.consolidated).toBe('0.0000');
    expect(r('2180')?.consolidated).toBe('0.0000');
    expect(r('4200')?.consolidated).toBe('0.0000');
    expect(r('6700')?.consolidated).toBe('0.0000');
    expect(r('1700')?.consolidated).toBe('0.0000');
    expect(r('1710')?.consolidated).toBe('20000.0000');
    expect(r('3400')?.consolidated).toBe('40000.0000');
    expect(tb.totals.netIncome).toBe('100000.0000'); // 160,000 - 60,000 after eliminating the 60,000 pair... net of parent expense
    expect(tb.totals.balanced).toBe(true);
    expect(nciShareOfProfit(out.translated, [parent, sub], PHP).toString()).toBe('32000.0000');
  });
  it('reserves earned since acquisition are shared with outside shareholders', () => {
    // 50,000 of reserves earned since acquisition, backed by cash so the member column still balances.
    const grown = {
      ...sub,
      rows: [
        ...sub.rows.map((x) => (x.code === '1130' ? { ...x, closing: '350000' } : x)),
        row('3200', '50000'),
      ],
    };
    const out = runEngine({
      currency: PHP,
      translationMethod: 'CLOSING_RATE',
      accounts: ACCOUNTS,
      members: [parent, grown],
      rules: [rules[2]!],
      chart,
    });
    const nci = out.adjustments.find((a) => a.type === 'NON_CONTROLLING_INTEREST')!;
    expect(nci.lines.find((l) => l.accountCode === '3400')!.credit).toBe('10000.0000'); // 20% x 50,000
    expect(nci.lines.find((l) => l.accountCode === '3200')!.debit).toBe('10000.0000');
  });
  it('an intercompany pair that does not mirror lands the residual in the difference account', () => {
    const lopsided = {
      ...sub,
      rows: sub.rows.map((x) => (x.code === '1290' ? { ...x, closing: '61000' } : x)),
    };
    const out = runEngine({
      currency: PHP,
      translationMethod: 'CLOSING_RATE',
      accounts: ACCOUNTS,
      members: [parent, lopsided],
      rules: [rules[0]!],
      chart,
    });
    const diff = out.adjustments[0]!.lines.find((l) => l.accountCode === '6980')!;
    expect(diff.debit).toBe('1000.0000');
    expect(adjustmentTotals(out.adjustments[0]!.lines, PHP).balanced).toBe(true);
  });
  it('equity-accounted members contribute only the share of their result', () => {
    const associate: MemberInput = {
      ...sub,
      companyId: 'A',
      code: 'ASSOC',
      method: 'EQUITY',
      ownershipPercent: '30',
      acquisitionEquity: '0',
      investmentCost: '0',
    };
    const out = runEngine({
      currency: PHP,
      translationMethod: 'CLOSING_RATE',
      accounts: ACCOUNTS,
      members: [parent, associate],
      rules: [rules[2]!],
      chart,
    });
    expect(out.translated.map((t) => t.companyId)).toEqual(['P']);
    const pickup = out.adjustments.find((a) => a.type === 'EQUITY_PICKUP')!;
    expect(pickup.lines.find((l) => l.accountCode === '1700')!.debit).toBe('48000.0000'); // 30% x 160,000
    expect(pickup.lines.find((l) => l.accountCode === '4950')!.credit).toBe('48000.0000');
  });
  it('custom and unrealized-profit rules post their template lines', () => {
    const out = runEngine({
      currency: PHP,
      translationMethod: 'CLOSING_RATE',
      accounts: ACCOUNTS,
      members: [parent],
      rules: [
        {
          id: 'u',
          code: 'URP',
          type: 'UNREALIZED_PROFIT',
          config: { amount: '2500', inventoryCode: '1300', costOfSalesCode: '5100' },
        },
        {
          id: 'c',
          code: 'RECLASS',
          type: 'CUSTOM',
          config: {
            lines: [
              { accountCode: '1130', debit: '10' },
              { accountCode: '3200', credit: '10' },
            ],
          },
        },
      ],
      chart,
    });
    expect(out.adjustments).toHaveLength(2);
    expect(out.adjustments[0]!.lines[0]).toMatchObject({ accountCode: '5100', debit: '2500.0000' });
    expect(out.adjustments[1]!.lines[1]).toMatchObject({ accountCode: '3200', credit: '10.0000' });
  });
});

describe('helpers', () => {
  it('averages daily rates and reports unbalanced adjustments', () => {
    expect(averageRate(['56', '57', '58'])).toBe('57.00000000');
    expect(averageRate([])).toBe('1');
    expect(
      adjustmentTotals(
        [
          { debit: '10', credit: '0' },
          { debit: '0', credit: '9' },
        ],
        PHP,
      ),
    ).toEqual({ debit: '10.0000', credit: '9.0000', balanced: false });
  });
});
