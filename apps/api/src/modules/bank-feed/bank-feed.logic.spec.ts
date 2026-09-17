import {
  historyKey,
  normalizeDescription,
  ruleMatches,
  suggestForLine,
  textMatches,
  type FeedLine,
  type OpenDocument,
  type RuleDef,
} from './bank-feed.logic';

const line = (partial: Partial<FeedLine>): FeedLine => ({
  id: 'l1',
  bankAccountId: 'bank-1',
  lineDate: '2026-09-10',
  amount: '-350',
  description: 'BANK SERVICE FEE SEP 2026',
  reference: null,
  ...partial,
});
const rule = (partial: Partial<RuleDef>): RuleDef => ({
  id: 'r1',
  name: 'Bank fees',
  priority: 10,
  bankAccountId: null,
  direction: 'OUT',
  descriptionPattern: 'service fee',
  descriptionMode: 'CONTAINS',
  referencePattern: null,
  referenceMode: 'CONTAINS',
  amountMin: null,
  amountMax: null,
  action: 'POST_TRANSACTION',
  transactionType: 'BANK_FEE',
  counterpartyAccountId: 'acc-6600',
  partyId: null,
  memo: 'Monthly service fee',
  departmentId: null,
  costCenterId: null,
  projectId: null,
  autoApply: true,
  ...partial,
});
const invoices: OpenDocument[] = [
  {
    id: 'inv1',
    documentNumber: 'INV-2026-000012',
    partyId: 'c1',
    partyName: 'Cebu Hardware Supply',
    openAmount: '15200',
    documentDate: '2026-08-01',
    reference: null,
  },
  {
    id: 'inv2',
    documentNumber: 'INV-2026-000013',
    partyId: 'c1',
    partyName: 'Cebu Hardware Supply',
    openAmount: '4800',
    documentDate: '2026-08-15',
    reference: null,
  },
  {
    id: 'inv3',
    documentNumber: 'INV-2026-000020',
    partyId: 'c2',
    partyName: 'Sunrise Grocers',
    openAmount: '15200',
    documentDate: '2026-08-20',
    reference: null,
  },
];
const ctx = {
  currency: 'PHP',
  rules: [rule({})],
  openInvoices: invoices,
  openBills: [],
  history: [],
  autoApplyRules: true,
  autoApplyDocumentMatches: false,
  historyMinOccurrences: 2,
};

describe('bank-feed.logic', () => {
  it('matches text by contains / starts-with / regex and rules by every condition', () => {
    expect(textMatches('GCash Payment 123', 'gcash', 'CONTAINS')).toBe(true);
    expect(textMatches('GCash Payment 123', 'payment', 'STARTS_WITH')).toBe(false);
    expect(textMatches('REF 88213', '^ref \\d+$', 'REGEX')).toBe(true);
    expect(textMatches('x', '[', 'REGEX')).toBe(false);
    expect(ruleMatches(rule({}), line({}), 'PHP')).toBe(true);
    expect(ruleMatches(rule({ direction: 'IN' }), line({}), 'PHP')).toBe(false);
    expect(ruleMatches(rule({ bankAccountId: 'other' }), line({}), 'PHP')).toBe(false);
    expect(ruleMatches(rule({ amountMax: '100' }), line({}), 'PHP')).toBe(false);
    expect(ruleMatches(rule({ amountMin: '300', amountMax: '400' }), line({}), 'PHP')).toBe(true);
    // A deposit-type rule never explains money out.
    expect(
      ruleMatches(rule({ transactionType: 'INTEREST', direction: 'ANY' }), line({}), 'PHP'),
    ).toBe(false);
    expect(
      ruleMatches(
        rule({
          action: 'RECEIVE_CUSTOMER',
          transactionType: null,
          direction: 'ANY',
          partyId: 'c1',
        }),
        line({}),
        'PHP',
      ),
    ).toBe(false);
  });

  it('normalizes descriptions so recurring feed lines share a history key', () => {
    expect(normalizeDescription('GCASH PAYMENT 2026-06-01 REF 88213 ACME')).toBe(
      'gcash payment ref acme',
    );
    expect(normalizeDescription('GCASH PAYMENT 2026-07-01 REF 91002 ACME')).toBe(
      'gcash payment ref acme',
    );
    expect(normalizeDescription('POS #4471 - 7/11 STORE')).toBe('pos store');
    expect(historyKey('POS PURCHASE 7-ELEVEN ORTIGAS')).toBe(
      historyKey('POS PURCHASE 7-ELEVEN MAKATI'),
    );
  });

  it('a rule wins first and auto-applies only when both the rule and the settings allow it', () => {
    const [first] = suggestForLine(line({}), ctx);
    expect(first).toMatchObject({
      source: 'RULE',
      action: 'POST_TRANSACTION',
      confidence: 'HIGH',
      autoApply: true,
      ruleId: 'r1',
    });
    expect(first!.payload.counterpartyAccountId).toBe('acc-6600');
    const [noAuto] = suggestForLine(line({}), { ...ctx, autoApplyRules: false });
    expect(noAuto!.autoApply).toBe(false);
    const [medium] = suggestForLine(line({}), { ...ctx, rules: [rule({ autoApply: false })] });
    expect(medium).toMatchObject({ confidence: 'MEDIUM', autoApply: false });
    // Lower priority number runs first.
    const [prio] = suggestForLine(line({}), {
      ...ctx,
      rules: [rule({ id: 'late', priority: 50 }), rule({ id: 'early', priority: 5 })],
    });
    expect(prio!.ruleId).toBe('early');
  });

  it('cited invoice numbers explain a receipt in full or in part; a lone open balance is a MEDIUM match', () => {
    const cited = suggestForLine(
      line({ amount: '20000', description: 'PAYMENT INV-2026-000012 INV-2026-000013' }),
      ctx,
    );
    expect(cited[0]).toMatchObject({
      source: 'DOCUMENT',
      action: 'RECEIVE_CUSTOMER',
      confidence: 'HIGH',
      autoApply: false,
    });
    expect(cited[0]!.payload.allocations!.map((a) => [a.documentNumber, a.amount])).toEqual([
      ['INV-2026-000012', '15200'],
      ['INV-2026-000013', '4800'],
    ]);
    const partial = suggestForLine(
      line({ amount: '10000', description: 'PART PAYMENT INV-2026-000012' }),
      { ...ctx, autoApplyDocumentMatches: true },
    );
    expect(partial[0]).toMatchObject({ confidence: 'HIGH', autoApply: false });
    expect(partial[0]!.payload.allocations![0]!.amount).toBe('10000.0000');
    // 15,200 is open on two invoices of different customers: ambiguous unless the party is named.
    expect(suggestForLine(line({ amount: '15200', description: 'DEPOSIT' }), ctx)).toHaveLength(0);
    const named = suggestForLine(
      line({ amount: '15200', description: 'DEPOSIT SUNRISE GROCERS' }),
      { ...ctx, autoApplyDocumentMatches: true },
    );
    expect(named[0]).toMatchObject({ confidence: 'HIGH', autoApply: true });
    expect(named[0]!.payload.partyId).toBe('c2');
    const unique = suggestForLine(line({ amount: '4800', description: 'DEPOSIT' }), ctx);
    expect(unique[0]).toMatchObject({ confidence: 'MEDIUM', autoApply: false });
    expect(unique[0]!.payload.allocations![0]!.documentNumber).toBe('INV-2026-000013');
  });

  it('history suggests what similar lines were explained as, MEDIUM from the configured occurrences', () => {
    const history = [
      {
        normalized: 'gcash payment ref',
        direction: 'IN' as const,
        occurrences: 3,
        payload: {
          action: 'POST_TRANSACTION' as const,
          transactionType: 'DEPOSIT' as const,
          counterpartyAccountId: 'acc-4900',
        },
        lastSeen: '2026-08-01',
      },
    ];
    const [h] = suggestForLine(
      line({ amount: '1200', description: 'GCASH PAYMENT 2026-09-01 REF 99001 ACME' }),
      { ...ctx, rules: [], history },
    );
    expect(h).toMatchObject({ source: 'HISTORY', confidence: 'MEDIUM', autoApply: false });
    expect(h!.payload.counterpartyAccountId).toBe('acc-4900');
    const [low] = suggestForLine(
      line({ amount: '1200', description: 'GCASH PAYMENT REF 1 ACME' }),
      { ...ctx, rules: [], history, historyMinOccurrences: 5 },
    );
    expect(low!.confidence).toBe('LOW');
  });
});
