import {
  assertWithinRemaining,
  computeOrderLines,
  deriveFulfillment,
  evaluateMatch,
  netUnitPrice,
  nextStatus,
  type MatchOrderLine,
} from './orders.logic';

const SETTINGS = {
  priceTolerancePercent: '0',
  quantityTolerancePercent: '0',
  requirePurchaseOrder: false,
  requireReceiptBeforeBill: true,
};
const poLine = (over: Partial<MatchOrderLine> = {}): MatchOrderLine => ({
  id: 'L1',
  lineNumber: 1,
  quantity: '100.0000',
  unitPrice: '80.0000',
  receivedQuantity: '80.0000',
  billedElsewhere: '0.0000',
  ...over,
});

describe('orders logic', () => {
  it('computes discounted line amounts and order totals exactly', () => {
    const { lines, subtotal, discountTotal, total } = computeOrderLines(
      [
        {
          description: 'A',
          quantity: '10',
          unitPrice: '250',
          discountPercent: '10',
          accountId: 'x',
        },
        {
          description: 'B',
          quantity: '3',
          unitPrice: '33.3333',
          discountPercent: '0',
          accountId: 'y',
        },
      ],
      'PHP',
    );
    expect(lines.map((l) => l.amount)).toEqual(['2250.0000', '99.9999']);
    expect(subtotal.toString()).toBe('2599.9999');
    expect(discountTotal.toString()).toBe('250.0000');
    expect(total.toString()).toBe('2349.9999');
    expect(netUnitPrice('250', '10', 'PHP').toString()).toBe('225.0000');
    expect(() =>
      computeOrderLines(
        [
          {
            description: 'free',
            quantity: '1',
            unitPrice: '10',
            discountPercent: '100',
            accountId: 'x',
          },
        ],
        'PHP',
      ),
    ).toThrow(/greater than zero/);
  });

  it('enforces the lifecycle per order type', () => {
    expect(nextStatus('QUOTATION', 'send', 'DRAFT')).toBe('SENT');
    expect(nextStatus('QUOTATION', 'convert', 'ACCEPTED')).toBe('CONVERTED');
    expect(() => nextStatus('QUOTATION', 'convert', 'DRAFT')).toThrow(/cannot be converted/);
    expect(() => nextStatus('SALES_ORDER', 'submit', 'DRAFT')).toThrow(/cannot be submitted/);
    expect(nextStatus('PURCHASE_REQUEST', 'submit', 'REJECTED')).toBe('SUBMITTED');
    expect(nextStatus('PURCHASE_ORDER', 'cancel', 'APPROVED')).toBe('CANCELLED');
  });

  it('derives fulfilment status and caps over-fulfilment with an optional tolerance', () => {
    expect(deriveFulfillment([{ quantity: '10', fulfilled: '0' }], 'PHP')).toBe('NONE');
    expect(
      deriveFulfillment(
        [
          { quantity: '10', fulfilled: '4' },
          { quantity: '1', fulfilled: '1' },
        ],
        'PHP',
      ),
    ).toBe('PARTIAL');
    expect(deriveFulfillment([{ quantity: '10', fulfilled: '10' }], 'PHP')).toBe('FULL');
    const line = { lineNumber: 1, quantity: '100', fulfilled: '80' };
    expect(() => assertWithinRemaining(line, '20', 'PHP', 'receiving')).not.toThrow();
    expect(() => assertWithinRemaining(line, '21', 'PHP', 'receiving')).toThrow(/exceeds/);
    expect(() => assertWithinRemaining(line, '30', 'PHP', 'receiving', '10')).not.toThrow();
    expect(() => assertWithinRemaining(line, '31', 'PHP', 'receiving', '10')).toThrow(/exceeds/);
  });

  it('three-way match: quantity, price and missing-receipt exceptions', () => {
    const bill = {
      purchaseOrderId: 'PO',
      duplicateSuspected: false,
      lines: [{ lineNumber: 1, orderLineId: 'L1', quantity: '100', unitPrice: '80' }],
    };
    const r = evaluateMatch(bill, new Map([['L1', poLine()]]), SETTINGS, 'PHP');
    expect(r.status).toBe('EXCEPTION');
    expect(r.exceptions.map((e) => e.code)).toEqual(['QUANTITY_MISMATCH']);

    const ok = evaluateMatch(
      bill,
      new Map([['L1', poLine({ receivedQuantity: '100' })]]),
      SETTINGS,
      'PHP',
    );
    expect(ok.status).toBe('MATCHED');

    const price = evaluateMatch(
      { ...bill, lines: [{ ...bill.lines[0]!, unitPrice: '84' }] },
      new Map([['L1', poLine({ receivedQuantity: '100' })]]),
      SETTINGS,
      'PHP',
    );
    expect(price.exceptions.map((e) => e.code)).toEqual(['PRICE_MISMATCH']);
    const tolerated = evaluateMatch(
      { ...bill, lines: [{ ...bill.lines[0]!, unitPrice: '84' }] },
      new Map([['L1', poLine({ receivedQuantity: '100' })]]),
      { ...SETTINGS, priceTolerancePercent: '5' },
      'PHP',
    );
    expect(tolerated.status).toBe('MATCHED');

    const nothing = evaluateMatch(
      bill,
      new Map([['L1', poLine({ receivedQuantity: '0' })]]),
      SETTINGS,
      'PHP',
    );
    expect(nothing.exceptions.map((e) => e.code)).toEqual(['MISSING_RECEIPT']);
    // Another bill already consumed the receipt.
    const consumed = evaluateMatch(
      { ...bill, lines: [{ ...bill.lines[0]!, quantity: '50' }] },
      new Map([['L1', poLine({ receivedQuantity: '100', billedElsewhere: '60' })]]),
      SETTINGS,
      'PHP',
    );
    expect(consumed.exceptions.map((e) => e.code)).toEqual(['QUANTITY_MISMATCH']);
  });

  it('three-way match: purchase-order requirement and duplicate suspicion', () => {
    const none = evaluateMatch(
      { purchaseOrderId: null, duplicateSuspected: false, lines: [] },
      new Map(),
      SETTINGS,
      'PHP',
    );
    expect(none.status).toBe('NOT_REQUIRED');
    const required = evaluateMatch(
      { purchaseOrderId: null, duplicateSuspected: true, lines: [] },
      new Map(),
      { ...SETTINGS, requirePurchaseOrder: true },
      'PHP',
    );
    expect(required.status).toBe('EXCEPTION');
    expect(required.exceptions.map((e) => e.code).sort()).toEqual([
      'DUPLICATE_INVOICE',
      'MISSING_PURCHASE_ORDER',
    ]);
  });
});
