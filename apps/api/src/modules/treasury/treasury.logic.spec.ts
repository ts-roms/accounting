import {
  DEFAULT_AGING_BUCKETS,
  DEFAULT_COLLECTION_PROBABILITIES,
  DEFAULT_SCENARIOS,
} from '@accounting/types';
import {
  bucketIndexFor,
  collectionProbabilityFor,
  daysCashOnHand,
  expandPlannedItem,
  expectedReceiptDate,
  forecastBuckets,
  pettyCashOnHand,
  renderPain001,
  renderPesonetCsv,
  renderPositivePayCsv,
  replenishmentDue,
  rollForecast,
  type ForecastFlow,
} from './treasury.logic';

const PHP = 'PHP';

describe('forecastBuckets', () => {
  it('builds contiguous weekly buckets that end exactly at the horizon', () => {
    const b = forecastBuckets('2026-09-14', 21, 'WEEK');
    expect(b.map((x) => [x.start, x.end])).toEqual([
      ['2026-09-14', '2026-09-20'],
      ['2026-09-21', '2026-09-27'],
      ['2026-09-28', '2026-10-04'],
    ]);
    expect(b.map((x) => x.label)).toEqual(['Sep 14-20', 'Sep 21-27', 'Sep 28-Oct 4']);
    expect(forecastBuckets('2026-09-14', 2, 'DAY').map((x) => x.label)).toEqual([
      'Sep 14',
      'Sep 15',
    ]);
    expect(forecastBuckets('2026-10-01', 61, 'MONTH').map((x) => x.label)).toEqual([
      'Oct 2026',
      'Nov 2026',
    ]);
  });
  it('monthly buckets break on calendar months and a short horizon truncates', () => {
    const b = forecastBuckets('2026-09-20', 25, 'MONTH');
    expect(b.map((x) => [x.start, x.end])).toEqual([
      ['2026-09-20', '2026-09-30'],
      ['2026-10-01', '2026-10-14'],
    ]);
    expect(bucketIndexFor('2026-09-01', b)).toBe(0); // overdue lands in the first bucket
    expect(bucketIndexFor('2026-10-10', b)).toBe(1);
    expect(bucketIndexFor('2026-12-31', b)).toBe(1); // beyond the horizon lands in the last
  });
});

describe('expandPlannedItem', () => {
  it('expands monthly items clamped to month ends and honours the end date', () => {
    expect(
      expandPlannedItem(
        { amount: '1', frequency: 'MONTHLY', startDate: '2026-01-31', endDate: '2026-04-15' },
        '2026-02-01',
        '2026-06-30',
      ),
    ).toEqual(['2026-02-28', '2026-03-31']);
  });
  it('ONCE yields a single date inside the window only', () => {
    expect(
      expandPlannedItem(
        { amount: '1', frequency: 'ONCE', startDate: '2026-03-01', endDate: null },
        '2026-02-01',
        '2026-02-28',
      ),
    ).toEqual([]);
    expect(
      expandPlannedItem(
        { amount: '1', frequency: 'BIWEEKLY', startDate: '2026-03-01', endDate: null },
        '2026-03-01',
        '2026-03-31',
      ),
    ).toEqual(['2026-03-01', '2026-03-15', '2026-03-29']);
  });
});

describe('AR weighting', () => {
  it('applies the bucket probability and shifts receipt dates by the scenario delay', () => {
    expect(
      collectionProbabilityFor(
        '2026-09-14',
        '2026-10-01',
        DEFAULT_AGING_BUCKETS,
        DEFAULT_COLLECTION_PROBABILITIES,
      ),
    ).toBe(0.95);
    expect(
      collectionProbabilityFor(
        '2026-09-14',
        '2026-07-01',
        DEFAULT_AGING_BUCKETS,
        DEFAULT_COLLECTION_PROBABILITIES,
      ),
    ).toBe(0.45);
    expect(expectedReceiptDate('2026-09-14', '2026-07-01', DEFAULT_SCENARIOS.BASE)).toBe(
      '2026-09-14',
    );
    expect(expectedReceiptDate('2026-09-14', '2026-10-01', DEFAULT_SCENARIOS.PESSIMISTIC)).toBe(
      '2026-10-15',
    );
  });
});

describe('rollForecast', () => {
  const buckets = forecastBuckets('2026-09-14', 14, 'WEEK');
  const flows: ForecastFlow[] = [
    {
      date: '2026-09-15',
      source: 'AR_INVOICES',
      direction: 'INFLOW',
      amount: '1000',
      bankAccountId: null,
      reference: 'a',
      label: '',
    },
    {
      date: '2026-09-16',
      source: 'AP_BILLS',
      direction: 'OUTFLOW',
      amount: '1500',
      bankAccountId: null,
      reference: 'b',
      label: '',
    },
    {
      date: '2026-09-25',
      source: 'PLANNED',
      direction: 'OUTFLOW',
      amount: '200',
      bankAccountId: null,
      reference: 'c',
      label: '',
    },
  ];
  it('rolls opening through inflows and outflows and flags minimum breaches', () => {
    const r = rollForecast('1000', flows, buckets, DEFAULT_SCENARIOS.BASE, '600', PHP);
    expect(r.buckets.map((b) => [b.opening, b.inflows, b.outflows, b.closing, b.breach])).toEqual([
      ['1000.0000', '1000.0000', '1500.0000', '500.0000', true],
      ['500.0000', '0.0000', '200.0000', '300.0000', true],
    ]);
    expect(r.breaches).toBe(2);
    expect(r.minimumClosing).toBe('300.0000');
    expect(r.buckets[0]!.bySource['OUTFLOW:AP_BILLS']).toBe('1500.0000');
  });
  it('scenario factors scale inflows and outflows', () => {
    const r = rollForecast(
      '1000',
      flows,
      buckets,
      { inflowFactor: '0.5', outflowFactor: '2', inflowDelayDays: 0 },
      '0',
      PHP,
    );
    expect(r.totalInflows).toBe('500.0000');
    expect(r.totalOutflows).toBe('3400.0000');
    expect(r.closing).toBe('-1900.0000');
  });
});

describe('KPIs and petty cash', () => {
  it('computes days cash on hand from the outflow window', () => {
    expect(daysCashOnHand('90000', '270000', 90, PHP)).toBe(30);
    expect(daysCashOnHand('90000', '0', 90, PHP)).toBeNull();
  });
  it('derives cash on hand and replenishment need from the imprest', () => {
    const onHand = pettyCashOnHand('20000', '14000', PHP);
    expect(onHand.toString()).toBe('6000.0000');
    expect(replenishmentDue('20000', onHand, '25', PHP)).toBe(false);
    expect(replenishmentDue('20000', pettyCashOnHand('20000', '15000', PHP), '25', PHP)).toBe(true);
  });
});

describe('payment file rendering', () => {
  const header = {
    fileNumber: 'PMF-2026-000001',
    valueDate: '2026-09-30',
    currency: PHP,
    originatorName: 'Acme Trading Corp',
    originatorId: 'ORG123',
    originatorAccount: '000123456789',
    originatorRouting: 'BNORPHMM',
    totalAmount: '1980.0000',
    count: 2,
  };
  const entries = [
    {
      sequence: 1,
      paymentNumber: 'PAY-1',
      amount: '980.0000',
      beneficiaryName: 'Acme, Inc.',
      beneficiaryBank: 'BPI',
      beneficiaryAccount: '1234567890',
      beneficiaryRouting: 'BOPIPHMM',
      remittanceInfo: 'BILL-1;BILL-2',
    },
    {
      sequence: 2,
      paymentNumber: 'PAY-2',
      amount: '1000.0000',
      beneficiaryName: 'Beta <Co>',
      beneficiaryBank: null,
      beneficiaryAccount: '99',
      beneficiaryRouting: null,
      remittanceInfo: 'BILL-3',
    },
  ];
  it('writes a PESONet batch with header, details and a checksummed trailer', () => {
    const csv = renderPesonetCsv(header, entries);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'H,PMF-2026-000001,20260930,PHP,Acme Trading Corp,ORG123,000123456789,BNORPHMM',
    );
    expect(lines[1]).toBe(
      'D,000001,BOPIPHMM,1234567890,"Acme, Inc.",980.0000,PHP,BILL-1;BILL-2,PAY-1',
    );
    expect(lines[3]!.startsWith('T,000002,1980.0000,')).toBe(true);
    expect(lines[3]!.split(',')[3]).toHaveLength(64);
  });
  it('writes pain.001 with control sums and escaped names', () => {
    const xml = renderPain001(header, entries);
    expect(xml).toContain('<NbOfTxs>2</NbOfTxs>');
    expect(xml).toContain('<CtrlSum>1980.0000</CtrlSum>');
    expect(xml).toContain('<Nm>Beta &lt;Co&gt;</Nm>');
    expect(xml).toContain('<InstdAmt Ccy="PHP">980.0000</InstdAmt>');
    expect(xml).toContain('<ReqdExctnDt>2026-09-30</ReqdExctnDt>');
  });
  it('writes a positive-pay register keyed by the paying account', () => {
    const csv = renderPositivePayCsv(header, entries);
    expect(csv.split('\r\n')[1]).toBe('000123456789,PAY-1,2026-09-30,980.0000,"Acme, Inc."');
  });
});
