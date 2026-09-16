import { Money } from '@accounting/money';
import { buildPrepaymentSchedule, endOfMonth } from './prepayments.logic';

describe('prepayment schedule logic', () => {
  it('dates each instalment on the last day of its month', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    const schedule = buildPrepaymentSchedule('120000', 'PHP', '2026-01-15', 3);
    expect(schedule.map((s) => s.recognitionDate)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });

  it('spreads the amount without losing a minor unit', () => {
    const schedule = buildPrepaymentSchedule('100', 'PHP', '2026-01-01', 3);
    expect(schedule.map((s) => s.amount)).toEqual(['33.3334', '33.3333', '33.3333']);
    const total = schedule.reduce(
      (acc, s) => acc.add(Money.of(s.amount, 'PHP')),
      Money.zero('PHP'),
    );
    expect(total.toString()).toBe('100.0000');
  });

  it('produces an equal straight line when the amount divides evenly', () => {
    const schedule = buildPrepaymentSchedule('120000', 'PHP', '2026-01-01', 12);
    expect(new Set(schedule.map((s) => s.amount))).toEqual(new Set(['10000.0000']));
    expect(schedule.at(-1)?.recognitionDate).toBe('2026-12-31');
  });
});
