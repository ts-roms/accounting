import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  REVENUE_POLICY_STATUSES,
  REVENUE_RECOGNITION_METHODS,
  REVENUE_RUN_STATUSES,
  REVENUE_SCHEDULE_LINE_STATUSES,
  REVENUE_SCHEDULE_STATUSES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { dimensionColumns } from './dimensions';
import { branches, companies } from './organizations';
import { customers, invoiceLines, invoices } from './subledger';
import { users } from './users';

/*
 * Revenue recognition & deferred revenue (Prompt #10).
 *
 * A posted invoice line under a deferring policy credits DEFERRED_REVENUE
 * instead of its revenue account and gets one `revenue_schedules` row whose
 * lines say when (or on which milestone) the revenue is earned. Recognition
 * runs post Dr deferred / Cr revenue for every due line in one journal; the
 * run is the source identity of the journal and each schedule line records
 * the run that recognized it. The deferred revenue balance in the ledger
 * must always equal the open schedule lines.
 */

export const revenueRecognitionMethodEnum = pgEnum(
  'revenue_recognition_method',
  REVENUE_RECOGNITION_METHODS,
);
export const revenuePolicyStatusEnum = pgEnum('revenue_policy_status', REVENUE_POLICY_STATUSES);
export const revenueScheduleStatusEnum = pgEnum(
  'revenue_schedule_status',
  REVENUE_SCHEDULE_STATUSES,
);
export const revenueScheduleLineStatusEnum = pgEnum(
  'revenue_schedule_line_status',
  REVENUE_SCHEDULE_LINE_STATUSES,
);
export const revenueRunStatusEnum = pgEnum('revenue_run_status', REVENUE_RUN_STATUSES);

// ----------------------------------------------------------------- policies

export const revenuePolicies = pgTable(
  'revenue_policies',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    method: revenueRecognitionMethodEnum('method').notNull(),
    description: text('description'),
    /** RATABLE: service length assumed when a line carries no end date. */
    defaultTermMonths: integer('default_term_months'),
    /** Included in the automatic month-end run. */
    autoRecognize: boolean('auto_recognize').notNull().default(true),
    status: revenuePolicyStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('revenue_policies_company_code_uq').on(t.companyId, t.code)],
);
export type RevenuePolicy = typeof revenuePolicies.$inferSelect;

export const revenueSettings = pgTable('revenue_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  /** The monthly job posts due lines by itself. */
  autoRecognize: boolean('auto_recognize').notNull().default(false),
  /** Pending lines older than this many days are flagged overdue. */
  overdueGraceDays: integer('overdue_grace_days').notNull().default(0),
  /** Policy for lines whose product has none (null = recognize at invoice). */
  defaultPolicyId: uuid('default_policy_id').references((): AnyPgColumn => revenuePolicies.id, {
    onDelete: 'set null',
  }),
  ...timestamps,
});
export type RevenueSettings = typeof revenueSettings.$inferSelect;

// ---------------------------------------------------------------- schedules

export const revenueSchedules = pgTable(
  'revenue_schedules',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references((): AnyPgColumn => invoices.id, { onDelete: 'restrict' }),
    invoiceLineId: uuid('invoice_line_id')
      .notNull()
      .references((): AnyPgColumn => invoiceLines.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references((): AnyPgColumn => customers.id, { onDelete: 'restrict' }),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => revenuePolicies.id, { onDelete: 'restrict' }),
    method: revenueRecognitionMethodEnum('method').notNull(),
    description: text('description').notNull(),
    /** Base currency - the schedule mirrors journal amounts. */
    currency: text('currency').notNull(),
    totalAmount: money('total_amount').notNull(),
    recognizedAmount: money('recognized_amount').notNull().default('0'),
    deferredAccountId: uuid('deferred_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    revenueAccountId: uuid('revenue_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    serviceStartDate: date('service_start_date'),
    serviceEndDate: date('service_end_date'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    status: revenueScheduleStatusEnum('status').notNull().default('ACTIVE'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('revenue_schedules_invoice_line_uq').on(t.invoiceLineId),
    index('revenue_schedules_company_status_idx').on(t.companyId, t.status),
    index('revenue_schedules_invoice_idx').on(t.invoiceId),
    index('revenue_schedules_customer_idx').on(t.customerId),
    check(
      'revenue_schedules_amount_chk',
      sql`${t.totalAmount} > 0 AND ${t.recognizedAmount} >= 0 AND ${t.recognizedAmount} <= ${t.totalAmount}`,
    ),
  ],
);
export type RevenueSchedule = typeof revenueSchedules.$inferSelect;

export const revenueRecognitionRuns = pgTable(
  'revenue_recognition_runs',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    documentNumber: text('document_number').notNull(),
    /** Every pending line dated on or before this date was recognized. */
    periodEnd: date('period_end').notNull(),
    description: text('description'),
    status: revenueRunStatusEnum('status').notNull().default('POSTED'),
    currency: text('currency').notNull(),
    totalAmount: money('total_amount').notNull(),
    lineCount: integer('line_count').notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
    /** Null when the scheduler posted the run. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('revenue_runs_company_number_uq').on(t.companyId, t.documentNumber),
    index('revenue_runs_company_period_idx').on(t.companyId, t.periodEnd),
  ],
);
export type RevenueRecognitionRun = typeof revenueRecognitionRuns.$inferSelect;

export const revenueScheduleLines = pgTable(
  'revenue_schedule_lines',
  {
    id: primaryId(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => revenueSchedules.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    /** RATABLE: the month end it belongs to. MILESTONE: expected date until completed, then the completion date. */
    recognitionDate: date('recognition_date'),
    amount: money('amount').notNull(),
    status: revenueScheduleLineStatusEnum('status').notNull().default('PENDING'),
    milestoneName: text('milestone_name'),
    milestonePercent: money('milestone_percent'),
    /** MILESTONE lines only become due once completed. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    completionNote: text('completion_note'),
    runId: uuid('run_id').references(() => revenueRecognitionRuns.id, { onDelete: 'set null' }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    recognizedAt: timestamp('recognized_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('revenue_schedule_lines_sequence_uq').on(t.scheduleId, t.sequence),
    index('revenue_schedule_lines_status_date_idx').on(t.status, t.recognitionDate),
    index('revenue_schedule_lines_run_idx').on(t.runId),
    check('revenue_schedule_lines_amount_chk', sql`${t.amount} >= 0`),
  ],
);
export type RevenueScheduleLine = typeof revenueScheduleLines.$inferSelect;
