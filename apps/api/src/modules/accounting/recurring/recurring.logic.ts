import type { RecurringFrequency } from '@accounting/types';

/*
 * Pure date arithmetic for recurring journal templates. Dates are ISO
 * `YYYY-MM-DD` strings; everything is computed in UTC so a template never
 * drifts with the server's time zone.
 */

const parse = (iso: string): [number, number, number] => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return [y, m, d];
};

const format = (date: Date): string => date.toISOString().slice(0, 10);

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Adds `months` calendar months, clamping the day to the target month's length
 * so a template starting on the 31st runs on the 28th/30th where needed.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = parse(iso);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return format(new Date(Date.UTC(year, month - 1, day)));
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = parse(iso);
  return format(new Date(Date.UTC(y, m - 1, d + days)));
}

/** The occurrence after `current` for a frequency / interval. */
export function nextOccurrence(
  current: string,
  frequency: RecurringFrequency,
  interval: number,
): string {
  const n = Math.max(1, interval);
  switch (frequency) {
    case 'DAILY':
      return addDays(current, n);
    case 'WEEKLY':
      return addDays(current, 7 * n);
    case 'MONTHLY':
      return addMonths(current, n);
    case 'QUARTERLY':
      return addMonths(current, 3 * n);
    case 'ANNUALLY':
      return addMonths(current, 12 * n);
  }
}

/**
 * The n-th occurrence (0-based) counted from the start date. Anchoring on the
 * start date keeps a month-end template on the month end: Jan 31 -> Feb 28 ->
 * Mar 31, instead of drifting to the 28th after February.
 */
export function occurrenceAt(
  startDate: string,
  frequency: RecurringFrequency,
  interval: number,
  n: number,
): string {
  const steps = Math.max(1, interval) * n;
  switch (frequency) {
    case 'DAILY':
      return addDays(startDate, steps);
    case 'WEEKLY':
      return addDays(startDate, 7 * steps);
    case 'MONTHLY':
      return addMonths(startDate, steps);
    case 'QUARTERLY':
      return addMonths(startDate, 3 * steps);
    case 'ANNUALLY':
      return addMonths(startDate, 12 * steps);
  }
}

/** First day of the month after `iso` - the default reversal date of an accrual. */
export function firstOfNextMonth(iso: string): string {
  const [y, m] = parse(iso);
  const total = y * 12 + m; // next month, zero-based offset already applied by using m
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return format(new Date(Date.UTC(year, month - 1, 1)));
}

export interface ScheduleState {
  frequency: RecurringFrequency;
  interval: number;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  /** Informational - the cursor is always derived from startDate + occurrences. */
  nextRunDate: string | null;
  occurrences: number;
}

/**
 * Every run date due on or before `asOf`, starting at `nextRunDate` (or the
 * start date for a fresh template), honouring the end date and the occurrence
 * cap. Returns the dates and the state the template should be left in.
 */
export function dueOccurrences(
  state: ScheduleState,
  asOf: string,
  limit = 120,
): { dates: string[]; nextRunDate: string | null; exhausted: boolean } {
  const dates: string[] = [];
  let count = state.occurrences;
  const at = (n: number) => occurrenceAt(state.startDate, state.frequency, state.interval, n);
  let cursor = at(count);
  const capped = () => state.maxOccurrences !== null && count >= state.maxOccurrences;
  const beyondEnd = (d: string) => state.endDate !== null && d > state.endDate;

  while (dates.length < limit && !capped() && !beyondEnd(cursor) && cursor <= asOf) {
    dates.push(cursor);
    count += 1;
    cursor = at(count);
  }
  const exhausted = capped() || beyondEnd(cursor);
  return { dates, nextRunDate: exhausted ? null : cursor, exhausted };
}
