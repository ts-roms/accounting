import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CLOSE_STATUSES,
  CLOSE_TASK_KINDS,
  CLOSE_TASK_STATUSES,
  CLOSE_TYPES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { fiscalPeriods } from './accounting';
import { companies } from './organizations';
import { users } from './users';

export const closeTypeEnum = pgEnum('close_type', CLOSE_TYPES);
export const closeStatusEnum = pgEnum('close_status', CLOSE_STATUSES);
export const closeTaskKindEnum = pgEnum('close_task_kind', CLOSE_TASK_KINDS);
export const closeTaskStatusEnum = pgEnum('close_task_status', CLOSE_TASK_STATUSES);

/**
 * A financial close for one fiscal period: the checklist, its blockers and
 * the approval that precedes closing (and optionally locking) the period.
 */
export const financialCloses = pgTable(
  'financial_closes',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
    closeType: closeTypeEnum('close_type').notNull().default('MONTH'),
    status: closeStatusEnum('status').notNull().default('IN_PROGRESS'),
    /** Snapshot of the last blocker evaluation. */
    blockers: jsonb('blockers').notNull().default([]),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvalNotes: text('approval_notes'),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    ...timestamps,
  },
  (t) => [
    /** One live close per period; completed and cancelled ones stay as the trail (a reopened period may be closed again). */
    uniqueIndex('financial_closes_period_live_uq')
      .on(t.fiscalPeriodId)
      .where(sql`${t.status} IN ('IN_PROGRESS', 'READY', 'APPROVED')`),
    index('financial_closes_company_status_idx').on(t.companyId, t.status),
  ],
);

export const closeTasks = pgTable(
  'close_tasks',
  {
    id: primaryId(),
    closeId: uuid('close_id')
      .notNull()
      .references(() => financialCloses.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    /** Stable key: an auto check name, or MANUAL_<slug>. */
    key: text('key').notNull(),
    title: text('title').notNull(),
    kind: closeTaskKindEnum('kind').notNull(),
    required: boolean('required').notNull().default(true),
    status: closeTaskStatusEnum('status').notNull().default('PENDING'),
    /** What the automatic check found (counts, names) for drill-down. */
    detail: jsonb('detail').notNull().default({}),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    skipReason: text('skip_reason'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('close_tasks_close_key_uq').on(t.closeId, t.key),
    index('close_tasks_close_idx').on(t.closeId, t.sequence),
  ],
);

export type FinancialClose = typeof financialCloses.$inferSelect;
export type CloseTask = typeof closeTasks.$inferSelect;
