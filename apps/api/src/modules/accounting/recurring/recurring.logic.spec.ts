import { addMonths, dueOccurrences, firstOfNextMonth, nextOccurrence } from './recurring.logic';

describe('recurring journal schedule logic', () => {
  it('adds months clamping to the last day of shorter months', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('computes the next occurrence per frequency and interval', () => {
    expect(nextOccurrence('2026-01-15', 'DAILY', 1)).toBe('2026-01-16');
    expect(nextOccurrence('2026-01-15', 'WEEKLY', 2)).toBe('2026-01-29');
    expect(nextOccurrence('2026-01-15', 'MONTHLY', 1)).toBe('2026-02-15');
    expect(nextOccurrence('2026-01-15', 'QUARTERLY', 1)).toBe('2026-04-15');
    expect(nextOccurrence('2026-01-15', 'ANNUALLY', 1)).toBe('2027-01-15');
  });

  it('gives the first day of the following month for accrual reversals', () => {
    expect(firstOfNextMonth('2026-03-15')).toBe('2026-04-01');
    expect(firstOfNextMonth('2026-12-31')).toBe('2027-01-01');
  });

  it('lists every occurrence due up to a date and advances the cursor', () => {
    const result = dueOccurrences(
      {
        frequency: 'MONTHLY',
        interval: 1,
        startDate: '2026-01-31',
        endDate: null,
        maxOccurrences: null,
        nextRunDate: null,
        occurrences: 0,
      },
      '2026-04-10',
    );
    expect(result.dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(result.nextRunDate).toBe('2026-04-30');
    expect(result.exhausted).toBe(false);
  });

  it('stops at the occurrence cap and at the end date', () => {
    const capped = dueOccurrences(
      {
        frequency: 'MONTHLY',
        interval: 1,
        startDate: '2026-01-01',
        endDate: null,
        maxOccurrences: 2,
        nextRunDate: '2026-02-01',
        occurrences: 1,
      },
      '2026-12-31',
    );
    expect(capped.dates).toEqual(['2026-02-01']);
    expect(capped.nextRunDate).toBeNull();
    expect(capped.exhausted).toBe(true);

    const ended = dueOccurrences(
      {
        frequency: 'WEEKLY',
        interval: 1,
        startDate: '2026-01-01',
        endDate: '2026-01-10',
        maxOccurrences: null,
        nextRunDate: '2026-01-01',
        occurrences: 0,
      },
      '2026-03-01',
    );
    expect(ended.dates).toEqual(['2026-01-01', '2026-01-08']);
    expect(ended.exhausted).toBe(true);
  });

  it('returns nothing when the next run is still in the future', () => {
    const result = dueOccurrences(
      {
        frequency: 'MONTHLY',
        interval: 1,
        startDate: '2026-06-01',
        endDate: null,
        maxOccurrences: null,
        nextRunDate: '2026-06-01',
        occurrences: 0,
      },
      '2026-05-31',
    );
    expect(result.dates).toEqual([]);
    expect(result.nextRunDate).toBe('2026-06-01');
  });
});
