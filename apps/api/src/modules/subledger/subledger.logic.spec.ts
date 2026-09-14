import { Money } from '@accounting/money';
import {
  addDays,
  agingBucket,
  computeLines,
  deriveDocumentStatus,
  validateAllocations,
  type AllocationTarget,
} from './subledger.logic';

describe('subledger logic', () => {
  it('computes line amounts exactly and rejects zero totals', () => {
    const { lines, subtotal } = computeLines(
      [
        { description: 'A', quantity: '3', unitPrice: '2500.5', accountId: 'x' },
        { description: 'B', quantity: '0.5', unitPrice: '0.3', accountId: 'y' },
      ],
      'PHP',
    );
    expect(lines.map((l) => l.amount)).toEqual(['7501.5000', '0.1500']);
    expect(subtotal.toString()).toBe('7501.6500');
    // 10 x 99.99 = 999.90 less 12.5% (124.9875) = 874.9125
    const discounted = computeLines(
      [
        {
          description: 'C',
          quantity: '10',
          unitPrice: '99.99',
          discountPercent: '12.5',
          accountId: 'x',
        },
      ],
      'PHP',
    );
    expect(discounted.lines[0]!.amount).toBe('874.9125');
    expect(() =>
      computeLines([{ description: 'zero', quantity: '1', unitPrice: '0', accountId: 'x' }], 'PHP'),
    ).toThrow(/greater than zero/);
  });

  it('derives business status from the settled amount', () => {
    const total = Money.of('100', 'PHP');
    expect(deriveDocumentStatus(total, Money.zero('PHP'))).toBe('APPROVED');
    expect(deriveDocumentStatus(total, Money.of('40', 'PHP'))).toBe('PARTIALLY_PAID');
    expect(deriveDocumentStatus(total, Money.of('100', 'PHP'))).toBe('PAID');
  });

  it('buckets by days overdue and handles due dates in the future', () => {
    expect(agingBucket('2026-09-11', '2026-09-20')).toBe('current');
    expect(agingBucket('2026-09-11', '2026-09-11')).toBe('current');
    expect(agingBucket('2026-09-11', '2026-09-01')).toBe('days1to30');
    expect(agingBucket('2026-09-11', '2026-07-21')).toBe('days31to60');
    expect(agingBucket('2026-09-11', '2026-06-21')).toBe('days61to90');
    expect(agingBucket('2026-09-11', '2026-01-15')).toBe('over90');
    expect(addDays('2026-01-31', 30)).toBe('2026-03-02');
  });

  describe('validateAllocations', () => {
    const target = (overrides: Partial<AllocationTarget>): AllocationTarget => ({
      id: 'inv1',
      documentNumber: 'INV-1',
      documentType: 'INVOICE',
      currency: 'PHP',
      exchangeRate: '1',
      status: 'APPROVED',
      accountingStatus: 'POSTED',
      partyId: 'cust',
      total: '100.0000',
      allocatedAmount: '30.0000',
      ...overrides,
    });
    const targets = new Map([['inv1', target({})]]);

    it('accepts allocations within the open balance and available amount', () => {
      expect(
        validateAllocations(
          [{ documentId: 'inv1', amount: '70' }],
          targets,
          'cust',
          Money.of('70', 'PHP'),
          'PHP',
        ).toString(),
      ).toBe('70.0000');
    });

    it('rejects over-allocation of the target or the source', () => {
      expect(() =>
        validateAllocations(
          [{ documentId: 'inv1', amount: '70.01' }],
          targets,
          'cust',
          Money.of('100', 'PHP'),
          'PHP',
        ),
      ).toThrow(/exceeds the open balance/);
      expect(() =>
        validateAllocations(
          [{ documentId: 'inv1', amount: '50' }],
          targets,
          'cust',
          Money.of('40', 'PHP'),
          'PHP',
        ),
      ).toThrow(/exceed the available amount/);
    });

    it('rejects other parties, credit notes, unposted documents and duplicates', () => {
      expect(() =>
        validateAllocations(
          [{ documentId: 'inv1', amount: '1' }],
          targets,
          'other',
          Money.of('1', 'PHP'),
          'PHP',
        ),
      ).toThrow(/different party/);
      expect(() =>
        validateAllocations(
          [{ documentId: 'cn', amount: '1' }],
          new Map([['cn', target({ id: 'cn', documentType: 'CREDIT_NOTE' })]]),
          'cust',
          Money.of('1', 'PHP'),
          'PHP',
        ),
      ).toThrow(/credit note/);
      expect(() =>
        validateAllocations(
          [{ documentId: 'd', amount: '1' }],
          new Map([['d', target({ id: 'd', accountingStatus: 'UNPOSTED', status: 'DRAFT' })]]),
          'cust',
          Money.of('1', 'PHP'),
          'PHP',
        ),
      ).toThrow(/not an open posted/);
      expect(() =>
        validateAllocations(
          [
            { documentId: 'inv1', amount: '1' },
            { documentId: 'inv1', amount: '1' },
          ],
          targets,
          'cust',
          Money.of('2', 'PHP'),
          'PHP',
        ),
      ).toThrow(/once/);
      expect(() =>
        validateAllocations(
          [{ documentId: 'missing', amount: '1' }],
          targets,
          'cust',
          Money.of('1', 'PHP'),
          'PHP',
        ),
      ).toThrow(/does not exist/);
    });
  });
});
