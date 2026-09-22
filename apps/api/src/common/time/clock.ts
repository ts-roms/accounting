/**
 * The business calendar date ("today") every default `asOf`, due-date and
 * scheduled job uses.
 *
 * Production leaves `APP_CLOCK_FIXED_DATE` unset and gets the real date. Test
 * and demo environments pin it (CI sets `2026-09-18`, the day the seed data
 * was written) so seeded invoices do not age into dunning steps, credit holds
 * or new aging buckets as the calendar moves on - the Playwright suite went red
 * on its own the day a seeded invoice passed 120 days overdue.
 *
 * Only calendar-date business logic goes through here. Wall-clock timestamps
 * (audit rows, sessions, job durations, `created_at`) stay `new Date()`.
 */
export function businessToday(): string {
  return process.env.APP_CLOCK_FIXED_DATE || new Date().toISOString().slice(0, 10);
}

/** `businessToday()` shifted by whole days (ISO date arithmetic in UTC). */
export function businessDateOffset(days: number): string {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
