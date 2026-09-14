import {
  classifyByHistory,
  detectAnomalies,
  extractFromText,
  forecastSeries,
  parseLooseDate,
  parsePeriod,
  parseQuestion,
  stats,
} from './ai.logic';

const SAMPLE_BILL = `Metro Office Supplies Inc.
TIN: 123-456-789-000
INVOICE
Invoice No: INV-2026-0451
Invoice Date: March 5, 2026
Due Date: 04/04/2026
Bill To: Acme Trading Corporation

Description                     Qty   Unit Price   Amount
A4 copy paper (box)              10     450.00     4,500.00
Toner cartridge HP 26A            2   3,200.00     6,400.00

Subtotal                                          10,900.00
VAT 12%                                            1,308.00
Total Amount Due                              PHP 12,208.00
`;

describe('ai.logic extraction', () => {
  it('reads header fields and lines from invoice text', () => {
    const r = extractFromText(SAMPLE_BILL);
    expect(r.kind).toBe('BILL');
    expect(r.fields.vendorName).toBe('Metro Office Supplies Inc.');
    expect(r.fields.vendorTaxId).toBe('123-456-789-000');
    expect(r.fields.reference).toBe('INV-2026-0451');
    expect(r.fields.documentDate).toBe('2026-03-05');
    expect(r.fields.dueDate).toBe('2026-04-04');
    expect(r.fields.total).toBe('12208.0000');
    expect(r.fields.taxAmount).toBe('1308.0000');
    expect(r.fields.subtotal).toBe('10900.0000');
    expect(r.fields.currency).toBe('PHP');
    expect(r.fields.lines).toEqual([
      { description: 'A4 copy paper (box)', quantity: '10.0000', unitPrice: '450.0000' },
      { description: 'Toner cartridge HP 26A', quantity: '2.0000', unitPrice: '3200.0000' },
    ]);
    expect(r.confidence).toBe(1);
  });

  it('parses loose dates and never yields impossible ones', () => {
    expect(parseLooseDate('2026-02-30')).toBeNull();
    expect(parseLooseDate('15/03/2026')).toBe('2026-03-15');
    expect(parseLooseDate('03/15/2026')).toBe('2026-03-15');
    expect(parseLooseDate('5 Mar 2026')).toBe('2026-03-05');
    expect(parseLooseDate('nonsense')).toBeNull();
  });

  it('classifies receipts as expense claims and scores low when little is found', () => {
    const r = extractFromText('Official Receipt\nCoffee Corner\nCash 250.00\nTotal 250.00');
    expect(r.kind).toBe('EXPENSE_CLAIM');
    expect(r.fields.total).toBe('250.0000');
    expect(r.confidence).toBeLessThan(0.7);
  });
});

describe('ai.logic classification', () => {
  const history = [
    {
      accountId: 'a-office',
      accountCode: '6200',
      accountName: 'Office Supplies',
      description: 'A4 copy paper',
      partyId: 'v1',
      taxCodeId: 't-vat',
      uses: 12,
    },
    {
      accountId: 'a-office',
      accountCode: '6200',
      accountName: 'Office Supplies',
      description: 'Toner cartridge',
      partyId: 'v1',
      taxCodeId: 't-vat',
      uses: 4,
    },
    {
      accountId: 'a-utils',
      accountCode: '6300',
      accountName: 'Utilities',
      description: 'Electricity bill March',
      partyId: 'v2',
      taxCodeId: null,
      uses: 6,
    },
    {
      accountId: 'a-rent',
      accountCode: '6100',
      accountName: 'Rent',
      description: 'Office rent',
      partyId: 'v3',
      taxCodeId: null,
      uses: 12,
    },
  ];

  it('prefers accounts used for the same party and similar descriptions', () => {
    const [best] = classifyByHistory(history, { description: 'Copy paper A4 box', partyId: 'v1' });
    expect(best?.accountCode).toBe('6200');
    expect(best?.taxCodeId).toBe('t-vat');
    expect(best?.confidence).toBeGreaterThan(0.8);
    expect(best?.rationale).toContain('used');
  });

  it('falls back to description similarity when the party is unknown', () => {
    const [best] = classifyByHistory(history, { description: 'electricity for the warehouse' });
    expect(best?.accountCode).toBe('6300');
  });

  it('returns nothing when nothing matches', () => {
    expect(classifyByHistory(history, { description: 'zzz' })).toEqual([]);
  });
});

describe('ai.logic anomalies', () => {
  const doc = (over: Partial<Parameters<typeof detectAnomalies>[0]['documents'][number]>) => ({
    entityType: 'BILL' as const,
    id: 'b1',
    number: 'BILL-1',
    partyId: 'v1',
    partyName: 'Vendor One',
    date: '2026-03-10',
    total: '1500.0000',
    reference: 'INV-1',
    createdBy: 'u1',
    approvedBy: 'u2',
    postedBy: 'u3',
    ...over,
  });

  it('flags duplicates, unusual and round amounts, control postings and one-person lifecycles', () => {
    const flags = detectAnomalies({
      documents: [
        doc({}),
        doc({ id: 'b2', number: 'BILL-2', date: '2026-03-12' }),
        doc({ id: 'b3', number: 'BILL-3', total: '50000.0000', reference: 'X', approvedBy: 'u1' }),
      ],
      journals: [
        {
          id: 'j1',
          number: 'JE-1',
          entryDate: '2026-01-02',
          createdAt: '2026-03-15T10:00:00Z',
          postedAt: '2026-03-15T10:00:00Z',
          createdBy: 'u1',
          approvedBy: 'u2',
          postedBy: 'u2',
          manual: true,
          total: '20000.0000',
          controlAccountsHit: ['1200'],
        },
      ],
      partyStats: new Map([['v1', stats(['1400', '1500', '1600', '1450', '1550', '1500'])]]),
    });
    const types = flags.map((f) => f.anomalyType).sort();
    expect(types).toEqual(
      [
        'DUPLICATE_DOCUMENT',
        'UNUSUAL_AMOUNT',
        'ROUND_AMOUNT',
        'ROUND_AMOUNT',
        'SAME_PERSON_LIFECYCLE',
        'SAME_PERSON_LIFECYCLE',
        'BACKDATED_ENTRY',
        'MANUAL_CONTROL_POSTING',
        'WEEKEND_POSTING',
      ].sort(),
    );
    const dup = flags.find((f) => f.anomalyType === 'DUPLICATE_DOCUMENT')!;
    expect(dup.entityId).toBe('b2');
    expect(dup.payload.sameReference).toBe(true);
    expect(new Set(flags.map((f) => f.fingerprint)).size).toBe(flags.length);
  });

  it('is quiet on ordinary data', () => {
    expect(
      detectAnomalies({
        documents: [doc({})],
        journals: [],
        partyStats: new Map(),
      }),
    ).toEqual([]);
  });
});

describe('ai.logic forecast', () => {
  it('extends a linear trend and reports the fit', () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      period: `2026-0${i + 1}`,
      value: String(1000 + i * 100),
    }));
    const f = forecastSeries(history, 2);
    expect(f.method).toBe('linear trend');
    expect(f.forecast.map((p) => p.period)).toEqual(['2026-07', '2026-08']);
    expect(f.forecast[0]!.value).toBe('1600.0000');
    expect(f.forecast[1]!.value).toBe('1700.0000');
    expect(f.r2).toBe(1);
    expect(f.slopePerMonth).toBe('100.0000');
  });

  it('handles an empty series', () => {
    expect(forecastSeries([], 3).forecast).toEqual([]);
  });
});

describe('ai.logic questions', () => {
  const today = '2026-09-14';

  it('resolves periods', () => {
    expect(parsePeriod('revenue last month', today)).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(parsePeriod('net income q2', today)).toMatchObject({
      from: '2026-04-01',
      to: '2026-06-30',
      label: 'Q2 2026',
    });
    expect(parsePeriod('expenses in march 2025', today)).toMatchObject({
      from: '2025-03-01',
      to: '2025-03-31',
    });
    expect(parsePeriod('last 3 months', today)).toMatchObject({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(parsePeriod('ytd revenue', today)).toMatchObject({
      from: '2026-01-01',
      to: '2026-09-30',
    });
    expect(parsePeriod('what is our cash', today)).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('detects intents', () => {
    expect(parseQuestion('What was our revenue last month?', today).intent).toBe('REVENUE');
    expect(parseQuestion('Are we profitable this year?', today).intent).toBe('NET_INCOME');
    expect(parseQuestion('How much cash do we have?', today)).toMatchObject({
      intent: 'CASH',
      pointInTime: true,
    });
    expect(parseQuestion('Which customers owe us the most?', today).intent).toBe('TOP_CUSTOMERS');
    expect(parseQuestion('overdue vendor bills', today).intent).toBe('AP_OVERDUE');
    expect(parseQuestion('top expenses in Q1', today).intent).toBe('TOP_EXPENSES');
    expect(parseQuestion('does the trial balance balance?', today).intent).toBe('TRIAL_BALANCE');
    expect(parseQuestion('any anomalies?', today).intent).toBe('ANOMALIES');
    expect(parseQuestion('forecast revenue', today).intent).toBe('FORECAST');
    expect(parseQuestion('help', today).intent).toBe('HELP');
  });
});
