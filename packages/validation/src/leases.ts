import { z } from 'zod';
import {
  LEASE_CLASSIFICATIONS,
  LEASE_PAYMENT_FREQUENCIES,
  LEASE_PAYMENT_TIMINGS,
  LEASE_RUN_STATUSES,
  LEASE_STATUSES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import { dimensionRefsSchema } from './dimensions';
import { nameSchema, optionalText, paginationQuerySchema, uuidSchema } from './primitives';

/*
 * Prompt #13 - lease accounting (lessee). Contracts are data; the schedule
 * is derived from the terms by the pure engine, and every ledger effect is a
 * posting decision (commence, run, pay, remeasure, terminate).
 */

const positiveAmount = amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive');

/** Annual discount rate in percent, up to 4 decimals ("8", "7.25"). */
export const leaseRateSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Rate must be a decimal percentage')
  .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'Rate must be between 0 and 100');

export const updateLeaseSettingsSchema = z.object({
  /** Leases whose term is at most this many months are exempt (expensed as paid). */
  shortTermThresholdMonths: z.coerce.number().int().min(0).max(36).optional(),
  /** Underlying asset value at or below which the lease is exempt (0 disables). */
  lowValueThreshold: amountSchema.optional(),
  /** Post lease runs from the scheduled job without review. */
  autoPostRuns: z.boolean().optional(),
  /** Default annual incremental borrowing rate used when a contract carries none. */
  defaultDiscountRate: leaseRateSchema.optional(),
});
export type UpdateLeaseSettingsInput = z.infer<typeof updateLeaseSettingsSchema>;

const leaseFields = dimensionRefsSchema.extend({
  name: nameSchema,
  description: optionalText(1000),
  /** The lessor; optional for exempt leases, required to commence a finance lease. */
  vendorId: uuidSchema.nullable().optional(),
  /** Presentation class of the underlying asset (drives the register grouping only). */
  assetCategoryId: uuidSchema.nullable().optional(),
  commencementDate: isoDateSchema,
  termMonths: z.coerce.number().int().min(1).max(600),
  paymentAmount: positiveAmount,
  paymentFrequency: z.enum(LEASE_PAYMENT_FREQUENCIES).default('MONTHLY'),
  paymentTiming: z.enum(LEASE_PAYMENT_TIMINGS).default('IN_ADVANCE'),
  /** Annual rate; falls back to the company default when omitted. */
  annualDiscountRate: leaseRateSchema.nullable().optional(),
  initialDirectCosts: amountSchema.default('0'),
  leaseIncentives: amountSchema.default('0'),
  /** Fair value of the underlying asset - the low-value test uses it. */
  underlyingAssetValue: amountSchema.nullable().optional(),
  /** Force a classification instead of deriving it from the thresholds. */
  classificationOverride: z.enum(LEASE_CLASSIFICATIONS).nullable().optional(),
  branchId: uuidSchema.nullable().optional(),
  location: optionalText(200),
  reference: optionalText(100),
  /** Bank account the payments are usually made from (forecast + default on pay). */
  bankAccountId: uuidSchema.nullable().optional(),
});

export const createLeaseSchema = leaseFields.superRefine((l, ctx) => {
  const step = l.paymentFrequency === 'MONTHLY' ? 1 : l.paymentFrequency === 'QUARTERLY' ? 3 : 12;
  if (l.termMonths % step !== 0)
    ctx.addIssue({
      code: 'custom',
      path: ['termMonths'],
      message: `The term must be a whole number of ${l.paymentFrequency.toLowerCase()} payment periods`,
    });
});
export type CreateLeaseInput = z.infer<typeof createLeaseSchema>;

/** Defaults are dropped so an omitted term never resets a saved one. */
export const updateLeaseSchema = leaseFields.partial().extend({
  paymentFrequency: z.enum(LEASE_PAYMENT_FREQUENCIES).optional(),
  paymentTiming: z.enum(LEASE_PAYMENT_TIMINGS).optional(),
  initialDirectCosts: amountSchema.optional(),
  leaseIncentives: amountSchema.optional(),
});
export type UpdateLeaseInput = z.infer<typeof updateLeaseSchema>;

export const listLeasesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(LEASE_STATUSES).optional(),
  classification: z.enum(LEASE_CLASSIFICATIONS).optional(),
  vendorId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type ListLeasesQuery = z.infer<typeof listLeasesQuerySchema>;

/** Commence: finance leases post Dr right-of-use asset / Cr lease liability (+ initial direct costs / incentives). */
export const commenceLeaseSchema = z.object({
  /** Defaults to the commencement date. */
  postingDate: isoDateSchema.optional(),
  /** Account credited for initial direct costs / debited for incentives (defaults to the clearing account). */
  clearingAccountId: uuidSchema.optional(),
});
export type CommenceLeaseInput = z.infer<typeof commenceLeaseSchema>;

/** Pay a schedule line: Dr lease liability (or lease expense for exempt leases) / Cr bank. */
export const payLeaseLineSchema = z.object({
  lineId: uuidSchema,
  bankAccountId: uuidSchema,
  paymentDate: isoDateSchema,
  reference: optionalText(100),
  memo: optionalText(500),
});
export type PayLeaseLineInput = z.infer<typeof payLeaseLineSchema>;

/**
 * Remeasure from an effective date: the remaining payments are re-discounted
 * (new term / payment / rate); the change in the liability adjusts the
 * right-of-use asset and the pending schedule is rebuilt.
 */
export const remeasureLeaseSchema = z
  .object({
    effectiveDate: isoDateSchema,
    /** New total term in months counted from commencement. */
    termMonths: z.coerce.number().int().min(1).max(600).optional(),
    paymentAmount: positiveAmount.optional(),
    annualDiscountRate: leaseRateSchema.optional(),
    notes: optionalText(500),
  })
  .refine(
    (r) => r.termMonths !== undefined || r.paymentAmount !== undefined || r.annualDiscountRate,
    'Change the term, the payment or the rate',
  );
export type RemeasureLeaseInput = z.infer<typeof remeasureLeaseSchema>;

/** Terminate: derecognize the right-of-use asset and the liability; the difference is a gain / loss. */
export const terminateLeaseSchema = z.object({
  terminationDate: isoDateSchema,
  notes: optionalText(500),
});
export type TerminateLeaseInput = z.infer<typeof terminateLeaseSchema>;

export const createLeaseRunSchema = z.object({
  /** Every pending line whose period ends on or before this date is posted. */
  periodEnd: isoDateSchema,
  description: optionalText(200),
  /** Restrict the run to these leases (defaults to every active finance lease). */
  leaseIds: z.array(uuidSchema).max(200).optional(),
});
export type CreateLeaseRunInput = z.infer<typeof createLeaseRunSchema>;

export const reverseLeaseRunSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type ReverseLeaseRunInput = z.infer<typeof reverseLeaseRunSchema>;

export const listLeaseRunsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(LEASE_RUN_STATUSES).optional(),
});
export type ListLeaseRunsQuery = z.infer<typeof listLeaseRunsQuerySchema>;

/** Preview the schedule for terms that are not saved yet. */
export const previewLeaseScheduleSchema = z.object({
  commencementDate: isoDateSchema,
  termMonths: z.coerce.number().int().min(1).max(600),
  paymentAmount: positiveAmount,
  paymentFrequency: z.enum(LEASE_PAYMENT_FREQUENCIES).default('MONTHLY'),
  paymentTiming: z.enum(LEASE_PAYMENT_TIMINGS).default('IN_ADVANCE'),
  annualDiscountRate: leaseRateSchema.optional(),
  initialDirectCosts: amountSchema.default('0'),
  leaseIncentives: amountSchema.default('0'),
});
export type PreviewLeaseScheduleInput = z.infer<typeof previewLeaseScheduleSchema>;

export const leaseAsOfQuerySchema = z.object({ asOf: isoDateSchema.optional() });
export type LeaseAsOfQuery = z.infer<typeof leaseAsOfQuerySchema>;

export const leaseMaturityQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  /** Years of buckets after the first twelve months (default 4). */
  years: z.coerce.number().int().min(1).max(10).optional(),
});
export type LeaseMaturityQuery = z.infer<typeof leaseMaturityQuerySchema>;
