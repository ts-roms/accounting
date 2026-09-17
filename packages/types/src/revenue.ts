/*
 * Prompt #10 - revenue recognition & deferred revenue. Enumerations shared by
 * the API, validation schemas and the web client.
 */

/**
 * POINT_IN_TIME: revenue is earned when the invoice posts (no deferral).
 * RATABLE: straight-line over the service period, prorated by day within
 * each calendar month. MILESTONE: fixed percentages released when each
 * milestone is marked complete.
 */
export const REVENUE_RECOGNITION_METHODS = ['POINT_IN_TIME', 'RATABLE', 'MILESTONE'] as const;
export type RevenueRecognitionMethod = (typeof REVENUE_RECOGNITION_METHODS)[number];

export const REVENUE_POLICY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type RevenuePolicyStatus = (typeof REVENUE_POLICY_STATUSES)[number];

/** ACTIVE while deferred revenue remains; COMPLETED once every line is recognized; CANCELLED when the invoice was voided. */
export const REVENUE_SCHEDULE_STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type RevenueScheduleStatus = (typeof REVENUE_SCHEDULE_STATUSES)[number];

/**
 * PENDING: waiting for its recognition date (or milestone completion).
 * RECOGNIZED: posted by a recognition run. CANCELLED: the schedule was
 * cancelled (voided invoice or reversed run) before the line posted.
 */
export const REVENUE_SCHEDULE_LINE_STATUSES = ['PENDING', 'RECOGNIZED', 'CANCELLED'] as const;
export type RevenueScheduleLineStatus = (typeof REVENUE_SCHEDULE_LINE_STATUSES)[number];

export const REVENUE_RUN_STATUSES = ['POSTED', 'REVERSED'] as const;
export type RevenueRunStatus = (typeof REVENUE_RUN_STATUSES)[number];

/** A milestone on an invoice line recognized under the MILESTONE method. */
export interface RevenueMilestone {
  name: string;
  /** Share of the line amount released when the milestone completes (all milestones sum to 100). */
  percent: string;
  /** Planned completion date - drives the waterfall / backlog until the milestone is completed. */
  expectedDate?: string | null;
}

/** Integrity checks run by `GET /revenue/integrity`. */
export const REVENUE_INTEGRITY_CHECKS = [
  'DEFERRED_REVENUE_VS_LEDGER',
  'SCHEDULE_TOTALS',
  'RECOGNIZED_WITHOUT_JOURNAL',
  'OVERDUE_RECOGNITION',
] as const;
export type RevenueIntegrityCheck = (typeof REVENUE_INTEGRITY_CHECKS)[number];
