import { Money } from '@accounting/money';
import {
  applyIssue,
  applyReceipt,
  averageCost,
  consumeFifo,
  issueWeightedAverage,
} from './valuation';

const PHP = 'PHP';

describe('inventory valuation', () => {
  it('FIFO consumes oldest layers first and prices partial layers exactly', () => {
    const layers = [
      { id: 'a', quantityRemaining: '10.0000', unitCost: '100.0000' },
      { id: 'b', quantityRemaining: '5.0000', unitCost: '120.0000' },
    ];
    const r = consumeFifo(layers, '12', PHP, null);
    expect(r.consumed.map((c) => [c.layerId, c.quantity.toString(), c.cost.toString()])).toEqual([
      ['a', '10.0000', '1000.0000'],
      ['b', '2.0000', '240.0000'],
    ]);
    expect(r.totalCost.toString()).toBe('1240.0000');
    expect(r.unitCost.toString()).toBe('103.3333');
    expect(r.uncovered.isZero()).toBe(true);
    expect(() => consumeFifo(layers, '16', PHP, null)).toThrow(/available/);
    const withFallback = consumeFifo(layers, '16', PHP, Money.of('90', PHP));
    expect(withFallback.uncovered.toString()).toBe('1.0000');
    expect(withFallback.totalCost.toString()).toBe('1690.0000'); // 1000 + 600 + 90
  });

  it('weighted average issues at the running average and relieves the exact value when emptied', () => {
    const balance = { quantityOnHand: '30.0000', totalCost: '3333.3333' };
    expect(averageCost(balance, PHP).toString()).toBe('111.1111');
    const partial = issueWeightedAverage(balance, '10', PHP, null);
    expect(partial.totalCost.toString()).toBe('1111.1110');
    const all = issueWeightedAverage(balance, '30', PHP, null);
    expect(all.totalCost.toString()).toBe('3333.3333');
    expect(() => issueWeightedAverage(balance, '31', PHP, null)).toThrow(/available/);
    const negative = issueWeightedAverage(balance, '31', PHP, Money.of('100', PHP));
    expect(negative.uncovered.toString()).toBe('1.0000');
    expect(negative.totalCost.toString()).toBe('3433.3333');
  });

  it('balance arithmetic is exact and a zero quantity carries zero value', () => {
    const after = applyReceipt(
      { quantityOnHand: '0', totalCost: '0' },
      '3',
      Money.of('299.9999', PHP),
      PHP,
    );
    expect(after.quantityOnHand.toString()).toBe('3.0000');
    expect(after.totalCost.toString()).toBe('299.9999');
    const issued = applyIssue(
      { quantityOnHand: '3.0000', totalCost: '299.9999' },
      '3',
      Money.of('299.9997', PHP),
      PHP,
    );
    expect(issued.quantityOnHand.isZero()).toBe(true);
    expect(issued.totalCost.isZero()).toBe(true);
  });
});
