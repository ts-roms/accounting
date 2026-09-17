import { Money } from '@accounting/money';
import type { RevenueMilestone, RevenueRecognitionMethod } from '@accounting/types';
import { endOfMonth } from '@/modules/accounting/prepayments/prepayments.logic';
import { addMonths } from '@/modules/accounting/recurring/recurring.logic';

/*
 * Pure revenue recognition arithmetic (Prompt #10): how an invoice line's
 * base amount is spread into schedule lines, and how open schedule lines roll
 * into the waterfall / rollforward views. Nothing here touches the database.
 */

export interface ScheduleLineDraft {
  sequence: number;
  /** Null only for milestones without an expected date. */
  recognitionDate: string | null;
  amount: string;
  milestoneName: string | null;
  milestonePercent: string | null;
}

function parseIso(iso: string): [number, number, number] {
  return iso.split('-').map(Number) as [number, number, number];
}

/** Whole days from `from` to `to`, both inclusive. */
export function inclusiveDays(from: string, to: string): number {
  const [fy, fm, fd] = parseIso(from);
  const [ty, tm, td] = parseIso(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = parseIso(iso);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** First calendar day of the month containing `iso`. */
export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * The service window a ratable line is spread over: explicit dates win, an
 * open end falls back to the policy's default term counted from the start.
 */
export function resolveServiceWindow(input: {
  documentDate: string;
  serviceStartDate?: string | null;
  serviceEndDate?: string | null;
  defaultTermMonths?: number | null;
}): { start: string; end: string } {
  const start = input.serviceStartDate ?? input.documentDate;
  const end =
    input.serviceEndDate ??
    (input.defaultTermMonths ? addDays(addMonths(start, input.defaultTermMonths), -1) : null);
  if (!end) throw new RangeError('A ratable line needs a service end date or a policy term');
  if (end < start) throw new RangeError('Service end precedes service start');
  return { start, end };
}

/**
 * Ratable schedule: one line per calendar month the service window touches,
 * each carrying the share of days it covers (`Money.allocate`, so the lines
 * sum to the amount exactly). A month is recognized on its last day; the
 * final month on the service end date.
 */
export function buildRatableSchedule(
  amount: string,
  currency: string,
  start: string,
  end: string,
): ScheduleLineDraft[] {
  if (end < start) throw new RangeError('Service end precedes service start');
  const segments: Array<{ recognitionDate: string; days: number }> = [];
  let cursor = start;
  while (cursor <= end) {
    const monthEnd = endOfMonth(cursor);
    const segmentEnd = monthEnd < end ? monthEnd : end;
    segments.push({ recognitionDate: segmentEnd, days: inclusiveDays(cursor, segmentEnd) });
    cursor = addDays(segmentEnd, 1);
  }
  const parts = Money.parse(amount, currency).allocate(segments.map((s) => s.days));
  return segments.map((s, i) => ({
    sequence: i + 1,
    recognitionDate: s.recognitionDate,
    amount: parts[i]!.toString(),
    milestoneName: null,
    milestonePercent: null,
  }));
}

/** Milestone percentages must be positive and sum to exactly 100. */
export function validateMilestones(milestones: readonly RevenueMilestone[]): void {
  if (milestones.length === 0)
    throw new RangeError('A milestone line needs at least one milestone');
  let total = Money.zero('PCT');
  for (const m of milestones) {
    const pct = Money.parse(m.percent, 'PCT');
    if (!pct.isPositive()) throw new RangeError(`Milestone "${m.name}" needs a positive percent`);
    total = total.add(pct);
  }
  if (!total.equals(Money.of(100, 'PCT')))
    throw new RangeError(`Milestone percentages sum to ${total.toString()}, not 100`);
}

/** Milestone schedule: the amount split by percent (largest remainder), dated on the expected date until completed. */
export function buildMilestoneSchedule(
  amount: string,
  currency: string,
  milestones: readonly RevenueMilestone[],
): ScheduleLineDraft[] {
  validateMilestones(milestones);
  const ratios = milestones.map((m) => Money.parse(m.percent, 'PCT').multiply(10_000).toNumber());
  const parts = Money.parse(amount, currency).allocate(ratios);
  return milestones.map((m, i) => ({
    sequence: i + 1,
    recognitionDate: m.expectedDate ?? null,
    amount: parts[i]!.toString(),
    milestoneName: m.name,
    milestonePercent: Money.parse(m.percent, 'PCT').toString(),
  }));
}

export function buildSchedule(input: {
  method: RevenueRecognitionMethod;
  amount: string;
  currency: string;
  documentDate: string;
  serviceStartDate?: string | null;
  serviceEndDate?: string | null;
  defaultTermMonths?: number | null;
  milestones?: readonly RevenueMilestone[];
}): { lines: ScheduleLineDraft[]; serviceStart: string | null; serviceEnd: string | null } {
  switch (input.method) {
    case 'RATABLE': {
      const { start, end } = resolveServiceWindow(input);
      return {
        lines: buildRatableSchedule(input.amount, input.currency, start, end),
        serviceStart: start,
        serviceEnd: end,
      };
    }
    case 'MILESTONE':
      return {
        lines: buildMilestoneSchedule(input.amount, input.currency, input.milestones ?? []),
        serviceStart: input.serviceStartDate ?? null,
        serviceEnd: input.serviceEndDate ?? null,
      };
    case 'POINT_IN_TIME':
      return { lines: [], serviceStart: null, serviceEnd: null };
  }
}

// ------------------------------------------------------------------ reports

export interface OpenLine {
  recognitionDate: string | null;
  amount: string;
  status: 'PENDING' | 'RECOGNIZED' | 'CANCELLED';
  /** MILESTONE lines only fall due once completed. */
  completed: boolean;
  method: RevenueRecognitionMethod;
}

export interface WaterfallBucket {
  month: string;
  amount: string;
}

/**
 * Deferred revenue waterfall: pending lines by the month they fall due,
 * starting at `from`'s month; lines dated before the window (overdue) land
 * in the first bucket, undated milestones in `unscheduled`.
 */
export function waterfall(
  lines: readonly OpenLine[],
  currency: string,
  from: string,
  months: number,
): { buckets: WaterfallBucket[]; unscheduled: string; beyond: string; total: string } {
  const start = startOfMonth(from);
  const keys = Array.from({ length: months }, (_, i) => addMonths(start, i).slice(0, 7));
  const sums = new Map<string, Money>(keys.map((k) => [k, Money.zero(currency)]));
  let unscheduled = Money.zero(currency);
  let beyond = Money.zero(currency);
  let total = Money.zero(currency);
  for (const line of lines) {
    if (line.status !== 'PENDING') continue;
    const amount = Money.parse(line.amount, currency);
    total = total.add(amount);
    if (!line.recognitionDate) {
      unscheduled = unscheduled.add(amount);
      continue;
    }
    const month = line.recognitionDate.slice(0, 7);
    const key = month < keys[0]! ? keys[0]! : month;
    const bucket = sums.get(key);
    if (bucket) sums.set(key, bucket.add(amount));
    else beyond = beyond.add(amount);
  }
  return {
    buckets: keys.map((k) => ({ month: k, amount: sums.get(k)!.toString() })),
    unscheduled: unscheduled.toString(),
    beyond: beyond.toString(),
    total: total.toString(),
  };
}

/** Sum of the pending schedule lines - what the ledger's deferred revenue account must hold. */
export function deferredBalance(lines: readonly OpenLine[], currency: string): Money {
  return Money.sum(
    lines.filter((l) => l.status === 'PENDING').map((l) => Money.parse(l.amount, currency)),
    currency,
  );
}
