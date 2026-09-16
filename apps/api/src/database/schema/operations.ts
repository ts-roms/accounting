import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { INTEGRITY_RUN_STATUSES, JOB_RUN_STATUSES, JOB_TRIGGERS } from '@accounting/types';
import { primaryId } from './_shared';
import { companies } from './organizations';
import { users } from './users';

export const jobRunStatusEnum = pgEnum('job_run_status', JOB_RUN_STATUSES);
export const jobTriggerEnum = pgEnum('job_trigger', JOB_TRIGGERS);
export const integrityRunStatusEnum = pgEnum('integrity_run_status', INTEGRITY_RUN_STATUSES);

/**
 * One row per execution of a registered background job (hardening H8):
 * scheduled, manual or startup. Executions are serialised per job name with
 * a PostgreSQL advisory lock, so a second instance records SKIPPED_LOCKED
 * instead of running the same schedule twice.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: primaryId(),
    jobName: text('job_name').notNull(),
    trigger: jobTriggerEnum('trigger').notNull().default('SCHEDULED'),
    status: jobRunStatusEnum('status').notNull().default('RUNNING'),
    /** `hostname:pid` of the API instance that ran it. */
    instanceId: text('instance_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    /** Whatever the job returned (counts, ids) - never financial figures. */
    result: jsonb('result'),
    error: text('error'),
    triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('job_runs_name_started_idx').on(t.jobName, t.startedAt),
    index('job_runs_status_idx').on(t.status, t.startedAt),
  ],
);

/**
 * Persisted outcome of a financial integrity check per company (nightly job
 * or manual). Findings keep name / severity / count only; the live report
 * is always re-run for drill-down so stored rows never become "the truth".
 */
export const integrityRuns = pgTable(
  'integrity_runs',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    asOf: date('as_of').notNull(),
    status: integrityRunStatusEnum('status').notNull(),
    criticalCount: integer('critical_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    findings: jsonb('findings')
      .$type<Array<{ name: string; severity: string; count: number }>>()
      .notNull()
      .default([]),
    error: text('error'),
    /** Whether holders of `integrity.check` were notified about a non-OK result. */
    notified: boolean('notified').notNull().default(false),
    jobRunId: uuid('job_run_id').references(() => jobRuns.id, { onDelete: 'set null' }),
    triggeredBy: uuid('triggered_by').references(() => users.id, { onDelete: 'set null' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('integrity_runs_company_ran_idx').on(t.companyId, t.ranAt)],
);

export type JobRun = typeof jobRuns.$inferSelect;
export type IntegrityRun = typeof integrityRuns.$inferSelect;
