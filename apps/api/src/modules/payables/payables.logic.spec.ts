import { DEFAULT_AGING_BUCKETS } from '@accounting/types';
import {
  cashRequirements,
  daysPayableOutstanding,
  discountAvailable,
  discountCaptureRate,
  discountWindowFor,
  grniValue,
  maskAccountNumber,
  payableBucketFor,
  proposePaymentRun,
  remittanceCsv,
  type RunCandidate,
} from './payables.logic';

const PHP = 'PHP';
const twoTenNet30 = {
  basis: 'NET_DAYS' as const,
  days: 30,
  dayOfMonth: null,
  discountPercent: '2',
  discountDays: 10,
};

describe('discountWindowFor', () => {
  it('derives due date, discount date and discount amount from 2/10 net 30', () => {
    expect(discountWindowFor('2026-03-01', '10000', PHP, twoTenNet30)).toEqual({
      dueDate: '2026-03-31',
      discountDate: '2026-03-11',
      discountAmount: '200.0000',
    });
  });

  it('has no discount window when the term offers none', () => {
    expect(
      discountWindowFor('2026-03-01', '10000', PHP, {
        ...twoTenNet30,
        discountPercent: null,
        discountDays: null,
      }),
    ).toEqual({ dueDate: '2026-03-31', discountDate: null, discountAmount: '0' });
  });
});

describe('discountAvailable', () => {
  const bill = {
    discountDate: '2026-03-11',
    discountAmount: '200',
    discountTakenAmount: '0',
    total: '10000',
    allocatedAmount: '0',
  };
  it('is the full discount inside the window and nothing after it', () => {
    expect(discountAvailable(bill, '2026-03-11', PHP).toString()).toBe('200.0000');
    expect(discountAvailable(bill, '2026-03-12', PHP).toString()).toBe('0.0000');
  });
  it('never exceeds the open balance nor what is left after a partial take', () => {
    expect(
      discountAvailable({ ...bill, allocatedAmount: '9900' }, '2026-03-05', PHP).toString(),
    ).toBe('100.0000');
    expect(
      discountAvailable({ ...bill, discountTakenAmount: '150' }, '2026-03-05', PHP).toString(),
    ).toBe('50.0000');
  });
});

describe('proposePaymentRun', () => {
  const candidate = (over: Partial<RunCandidate> & { billId: string }): RunCandidate => ({
    vendorId: 'V1',
    dueDate: '2026-03-31',
    discountDate: null,
    openAmount: '1000',
    discountAvailable: '0',
    onHold: false,
    vendorOnHold: false,
    minimumPaymentAmount: null,
    ...over,
  });

  it('selects due bills oldest first, skips holds and takes available discounts', () => {
    const lines = proposePaymentRun(
      [
        candidate({ billId: 'b-late', dueDate: '2026-04-15' }),
        candidate({ billId: 'b-hold', dueDate: '2026-03-01', onHold: true }),
        candidate({ billId: 'b-due', dueDate: '2026-03-20', discountAvailable: '20' }),
        candidate({ billId: 'b-vhold', dueDate: '2026-03-02', vendorId: 'V9', vendorOnHold: true }),
      ],
      { mode: 'DUE', payThroughDate: '2026-03-31', maximumAmount: null, currency: PHP },
    );
    expect(lines.map((l) => [l.billId, l.skipped ?? 'SELECTED', l.amount])).toEqual([
      ['b-hold', 'ON_HOLD', '0'],
      ['b-vhold', 'VENDOR_ON_HOLD', '0'],
      ['b-due', 'SELECTED', '980.0000'],
      ['b-late', 'NOT_DUE', '0'],
    ]);
  });

  it('DUE_OR_DISCOUNT also takes bills whose discount is still open, and the maximum caps the run', () => {
    const lines = proposePaymentRun(
      [
        candidate({ billId: 'a', dueDate: '2026-03-10' }),
        candidate({ billId: 'b', dueDate: '2026-04-20', discountAvailable: '30' }),
        candidate({ billId: 'c', dueDate: '2026-03-12', openAmount: '5000' }),
      ],
      {
        mode: 'DUE_OR_DISCOUNT',
        payThroughDate: '2026-03-15',
        maximumAmount: '2500',
        currency: PHP,
      },
    );
    const byId = Object.fromEntries(lines.map((l) => [l.billId, l]));
    expect(byId.a!.skipped).toBeUndefined();
    expect(byId.c!.skipped).toBe('OVER_MAXIMUM');
    expect(byId.b!.skipped).toBeUndefined();
    expect(byId.b!.amount).toBe('970.0000');
  });

  it('drops a vendor whose selected total stays below its minimum payment', () => {
    const lines = proposePaymentRun(
      [
        candidate({ billId: 'x', openAmount: '300', minimumPaymentAmount: '1000' }),
        candidate({ billId: 'y', openAmount: '400', minimumPaymentAmount: '1000' }),
        candidate({ billId: 'z', vendorId: 'V2', openAmount: '50' }),
      ],
      { mode: 'DUE', payThroughDate: '2026-03-31', maximumAmount: null, currency: PHP },
    );
    expect(lines.filter((l) => l.skipped === 'BELOW_MINIMUM').map((l) => l.billId)).toEqual([
      'x',
      'y',
    ]);
    expect(lines.find((l) => l.billId === 'z')!.skipped).toBeUndefined();
  });
});

describe('cashRequirements', () => {
  it('bands open bills into overdue, the horizons and beyond', () => {
    const out = cashRequirements(
      [
        { dueDate: '2026-03-01', openAmount: '100', discountAvailable: '0' },
        { dueDate: '2026-03-12', openAmount: '200', discountAvailable: '4' },
        { dueDate: '2026-03-30', openAmount: '300', discountAvailable: '0' },
        { dueDate: '2026-05-30', openAmount: '400', discountAvailable: '0' },
        { dueDate: '2026-09-01', openAmount: '500', discountAvailable: '0' },
      ],
      '2026-03-10',
      [7, 30, 60],
      PHP,
    );
    expect(out.map((b) => [b.label, b.amount, b.billCount])).toEqual([
      ['Overdue', '100.0000', 1],
      ['Next 7 days', '200.0000', 1],
      ['8-30 days', '300.0000', 1],
      ['31-60 days', '0.0000', 0],
      ['Beyond 60 days', '900.0000', 2],
    ]);
    expect(out[1]!.discountAvailable).toBe('4.0000');
  });
});

describe('DPO, discount capture, GRNI and aging', () => {
  it('computes countback DPO and discount capture rate', () => {
    expect(daysPayableOutstanding('90000', '270000', 90, PHP)).toBe(30);
    expect(daysPayableOutstanding('90000', '0', 90, PHP)).toBe(0);
    expect(discountCaptureRate('75', '100', PHP)).toBe(0.75);
    expect(discountCaptureRate('0', '0', PHP)).toBe(1);
  });

  it('values received-not-billed quantity at the PO price with an age', () => {
    const v = grniValue(
      {
        orderLineId: 'l',
        receivedQuantity: '10',
        billedQuantity: '4',
        unitPrice: '250',
        lastReceiptDate: '2026-03-01',
      },
      '2026-03-31',
      PHP,
    );
    expect(v.quantity).toBe('6');
    expect(v.amount.toString()).toBe('1500.0000');
    expect(v.ageDays).toBe(30);
  });

  it('buckets bills like the AR aging does', () => {
    expect(payableBucketFor('2026-03-31', '2026-04-05', DEFAULT_AGING_BUCKETS)).toBe('current');
    expect(payableBucketFor('2026-03-31', '2026-02-15', DEFAULT_AGING_BUCKETS)).toBe('days31to60');
  });
});

describe('remittance', () => {
  it('masks account numbers except the last four', () => {
    expect(maskAccountNumber('1234 5678 9012')).toBe('********9012');
    expect(maskAccountNumber('123')).toBe('***');
  });

  it('writes RFC 4180 CSV with quoted fields', () => {
    const csv = remittanceCsv([
      {
        vendorCode: 'V-1',
        vendorName: 'Acme, Inc.',
        paymentNumber: 'VP-1',
        paymentDate: '2026-03-31',
        amount: '980.0000',
        currency: PHP,
        method: 'BANK_TRANSFER',
        bankName: 'BDO',
        accountName: 'Acme',
        accountNumber: '001234567890',
        routingCode: null,
        bills: 'BILL-1;BILL-2',
      },
    ]);
    expect(csv.split('\r\n')[1]).toBe(
      'V-1,"Acme, Inc.",VP-1,2026-03-31,980.0000,PHP,BANK_TRANSFER,BDO,Acme,001234567890,,BILL-1;BILL-2',
    );
  });
});
