import { buildCashFlowStatement, defaultActivity, type CashFlowAccount } from './cash-flow.logic';

const acct = (
  id: string,
  type: CashFlowAccount['type'],
  subtype: CashFlowAccount['subtype'] = null,
  extra: Partial<CashFlowAccount> = {},
): CashFlowAccount => ({
  id,
  code: id,
  name: id,
  type,
  subtype,
  isHeader: false,
  cashFlowActivity: null,
  ...extra,
});

const chart = [
  acct('bank', 'ASSET', 'BANK'),
  acct('ar', 'ASSET', 'ACCOUNTS_RECEIVABLE'),
  acct('equip', 'ASSET', 'FIXED_ASSET'),
  acct('accdep', 'ASSET', 'ACCUMULATED_DEPRECIATION'),
  acct('ap', 'LIABILITY', 'ACCOUNTS_PAYABLE'),
  acct('loan', 'LIABILITY', 'LOAN'),
  acct('capital', 'EQUITY', 'SHARE_CAPITAL'),
  acct('sales', 'REVENUE', 'SALES'),
  acct('dep', 'EXPENSE', 'DEPRECIATION_EXPENSE'),
  acct('rent', 'EXPENSE', 'OPERATING_EXPENSE'),
  acct('hdr', 'ASSET', null, { isHeader: true }),
];

describe('cash-flow statement (indirect)', () => {
  it('classifies by explicit activity, then subtype, then type', () => {
    expect(defaultActivity(acct('x', 'ASSET', 'FIXED_ASSET'))).toBe('INVESTING');
    expect(defaultActivity(acct('x', 'ASSET', 'ACCUMULATED_DEPRECIATION'))).toBe('OPERATING');
    expect(defaultActivity(acct('x', 'LIABILITY', 'LOAN'))).toBe('FINANCING');
    expect(defaultActivity(acct('x', 'EQUITY', null))).toBe('FINANCING');
    expect(
      defaultActivity(acct('x', 'ASSET', 'OTHER_ASSET', { cashFlowActivity: 'INVESTING' })),
    ).toBe('INVESTING');
  });

  it('reconciles net income and working-capital changes to the cash movement', () => {
    // Period: capital 1000 in; sales 500 (300 collected); equipment 400 bought
    // on a 400 loan; depreciation 50; rent 100 unpaid (AP).
    const period = [
      { accountId: 'bank', debit: '1300', credit: '0' },
      { accountId: 'capital', debit: '0', credit: '1000' },
      { accountId: 'ar', debit: '500', credit: '300' },
      { accountId: 'sales', debit: '0', credit: '500' },
      { accountId: 'equip', debit: '400', credit: '0' },
      { accountId: 'loan', debit: '0', credit: '400' },
      { accountId: 'dep', debit: '50', credit: '0' },
      { accountId: 'accdep', debit: '0', credit: '50' },
      { accountId: 'rent', debit: '100', credit: '0' },
      { accountId: 'ap', debit: '0', credit: '100' },
    ];
    const s = buildCashFlowStatement({
      chart,
      opening: [{ accountId: 'bank', debit: '200', credit: '0' }],
      period,
      currency: 'PHP',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(s.netIncome).toBe('350.0000'); // 500 - 50 - 100
    expect(s.operating.total).toBe('300.0000'); // 350 - 200 (AR) + 50 (dep) + 100 (AP)
    expect(s.investing.total).toBe('-400.0000');
    expect(s.financing.total).toBe('1400.0000');
    expect(s.netChangeInCash).toBe('1300.0000');
    expect(s.openingCash).toBe('200.0000');
    expect(s.closingCash).toBe('1500.0000');
    expect(s.balanced).toBe(true);
    expect(s.operating.lines.map((l) => l.code)).toEqual(['ar', 'accdep', 'ap']);
  });

  it('flags an unbalanced ledger instead of hiding it', () => {
    const s = buildCashFlowStatement({
      chart,
      opening: [],
      period: [{ accountId: 'bank', debit: '10', credit: '0' }],
      currency: 'PHP',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(s.balanced).toBe(false);
  });
});
