import { z } from 'zod';
import { JOB_RUN_STATUSES } from '@accounting/types';
import { paginationQuerySchema, uuidSchema } from './primitives.js';

// ----------------------------------------------------------- operations (H8)

export const jobNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Job names are kebab-case');

export const listJobRunsQuerySchema = paginationQuerySchema.extend({
  jobName: jobNameSchema.optional(),
  status: z.enum(JOB_RUN_STATUSES).optional(),
});
export type ListJobRunsQuery = z.infer<typeof listJobRunsQuerySchema>;

export const listIntegrityRunsQuerySchema = paginationQuerySchema.extend({
  companyId: uuidSchema.optional(),
});
export type ListIntegrityRunsQuery = z.infer<typeof listIntegrityRunsQuerySchema>;

export const runIntegrityCheckSchema = z.object({
  companyId: uuidSchema,
});
export type RunIntegrityCheckInput = z.infer<typeof runIntegrityCheckSchema>;

/** Top statements from pg_stat_statements for the operations console. */
export const statementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  orderBy: z.enum(['total', 'mean', 'calls', 'rows']).default('total'),
});
export type StatementsQuery = z.infer<typeof statementsQuerySchema>;

export const queueNameSchema = z.enum([
  'maintenance',
  'accounting-schedules',
  'integration-sync',
  'webhook-delivery',
  'webhook-inbound',
  'integration-maintenance',
]);
export type QueueNameInput = z.infer<typeof queueNameSchema>;

export const failedJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
