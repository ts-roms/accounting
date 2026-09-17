import { z } from 'zod';
import {
  REVENUE_POLICY_STATUSES,
  REVENUE_RECOGNITION_METHODS,
  REVENUE_RUN_STATUSES,
  REVENUE_SCHEDULE_STATUSES,
} from '@accounting/types';
import { isoDateSchema } from './accounting';
import {
  codeSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  uuidSchema,
} from './primitives';

// ----------------------------------------------------------------- policies

export const createRevenuePolicySchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    method: z.enum(REVENUE_RECOGNITION_METHODS),
    description: optionalText(500),
    /** RATABLE: service length assumed when a line carries no end date. */
    defaultTermMonths: z.coerce.number().int().min(1).max(120).nullable().optional(),
    /** Recognize deferred revenue for this policy in the automatic month-end run. */
    autoRecognize: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    if (p.method !== 'RATABLE' && p.defaultTermMonths)
      ctx.addIssue({
        code: 'custom',
        path: ['defaultTermMonths'],
        message: 'Only ratable policies carry a default term',
      });
  });
export type CreateRevenuePolicyInput = z.infer<typeof createRevenuePolicySchema>;

export const updateRevenuePolicySchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
  defaultTermMonths: z.coerce.number().int().min(1).max(120).nullable().optional(),
  autoRecognize: z.boolean().optional(),
  status: z.enum(REVENUE_POLICY_STATUSES).optional(),
});
export type UpdateRevenuePolicyInput = z.infer<typeof updateRevenuePolicySchema>;

// ----------------------------------------------------------------- settings

export const updateRevenueSettingsSchema = z.object({
  /** The monthly job posts due recognition lines without a person clicking Recognize. */
  autoRecognize: z.boolean().optional(),
  /** Warn (notification + integrity) when pending lines are older than this many days. */
  overdueGraceDays: z.coerce.number().int().min(0).max(90).optional(),
  /** Policy applied to lines of products without an explicit policy (null = recognize at invoice). */
  defaultPolicyId: uuidSchema.nullable().optional(),
});
export type UpdateRevenueSettingsInput = z.infer<typeof updateRevenueSettingsSchema>;

// ---------------------------------------------------------------- schedules

export const listRevenueSchedulesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(REVENUE_SCHEDULE_STATUSES).optional(),
  method: z.enum(REVENUE_RECOGNITION_METHODS).optional(),
  customerId: uuidSchema.optional(),
  invoiceId: uuidSchema.optional(),
  policyId: uuidSchema.optional(),
});
export type ListRevenueSchedulesQuery = z.infer<typeof listRevenueSchedulesQuerySchema>;

export const completeMilestoneSchema = z.object({
  /** Recognition date of the released amount (defaults to today). */
  completedOn: isoDateSchema.optional(),
  note: optionalText(500),
});
export type CompleteMilestoneInput = z.infer<typeof completeMilestoneSchema>;

// --------------------------------------------------------------------- runs

export const createRevenueRunSchema = z.object({
  /** Recognize every pending line dated on or before this date. */
  periodEnd: isoDateSchema,
  description: optionalText(200),
  /** Limit the run to these schedules (default: every due schedule of the company). */
  scheduleIds: z.array(uuidSchema).max(500).optional(),
});
export type CreateRevenueRunInput = z.infer<typeof createRevenueRunSchema>;

export const reverseRevenueRunSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type ReverseRevenueRunInput = z.infer<typeof reverseRevenueRunSchema>;

export const listRevenueRunsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(REVENUE_RUN_STATUSES).optional(),
});
export type ListRevenueRunsQuery = z.infer<typeof listRevenueRunsQuerySchema>;

// ------------------------------------------------------------------ reports

export const revenueRollforwardQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((q) => q.to >= q.from, { message: 'Period end precedes start', path: ['to'] });
export type RevenueRollforwardQuery = z.infer<typeof revenueRollforwardQuerySchema>;

export const revenueWaterfallQuerySchema = z.object({
  /** First month of the waterfall (any date within it; defaults to the current month). */
  from: isoDateSchema.optional(),
  months: z.coerce.number().int().min(1).max(36).default(12),
});
export type RevenueWaterfallQuery = z.infer<typeof revenueWaterfallQuerySchema>;

export const revenueBacklogQuerySchema = z.object({ asOf: isoDateSchema.optional() });
export type RevenueBacklogQuery = z.infer<typeof revenueBacklogQuerySchema>;

export const revenueIntegrityQuerySchema = z.object({ asOf: isoDateSchema.optional() });
export type RevenueIntegrityQuery = z.infer<typeof revenueIntegrityQuerySchema>;
