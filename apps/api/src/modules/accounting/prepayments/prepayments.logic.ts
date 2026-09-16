import { Money } from '@accounting/money';
import { addMonths } from '../recurring/recurring.logic';

/*
 * Pure prepayment arithmetic: an amount spread over N monthly recognitions
 * without losing a minor unit, each dated on the last day of its month.
 */

export interface ScheduleInstalment {
  sequence: number;
  recognitionDate: string;
  amount: string;
}

/** Last calendar day of the month containing `iso`. */
export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * Straight-line schedule: `Money.allocate` splits the amount into equal parts
 * with the remainder on the earliest instalments, so the sum is exactly the
 * amount and the final recognition leaves the prepaid balance at zero.
 */
export function buildPrepaymentSchedule(
  amount: string,
  currency: string,
  startDate: string,
  months: number,
): ScheduleInstalment[] {
  if (months < 1) throw new RangeError('months must be >= 1');
  const parts = Money.parse(amount, currency).allocate(Array<number>(months).fill(1));
  return parts.map((part, index) => ({
    sequence: index + 1,
    recognitionDate: endOfMonth(addMonths(startDate, index)),
    amount: part.toString(),
  }));
}
