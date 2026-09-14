import { addDays, addMonths, endOfMonth } from './fiscal-periods.service';

describe('fiscal date helpers', () => {
  it('adds months without timezone drift', () => {
    expect(addMonths('2026-01-01', 12)).toBe('2027-01-01');
    expect(addMonths('2026-07-01', 6)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-03-03'); // JS overflow, only ever called with day 01
  });

  it('computes month ends including leap years', () => {
    expect(endOfMonth('2026-02-01')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-01')).toBe('2028-02-29');
    expect(endOfMonth('2026-12-01')).toBe('2026-12-31');
  });

  it('subtracts days across year boundaries', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
});
