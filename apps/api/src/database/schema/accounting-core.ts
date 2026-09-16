import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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
  DIMENSION_RULE_SCOPES,
  PREPAYMENT_SCHEDULE_STATUSES,
  PREPAYMENT_STATUSES,
  RECURRING_FREQUENCIES,
  RECURRING_JOURNAL_MODES,
  RECURRING_JOURNAL_STATUSES,
  type AccountMappingKey,
  type PostingRuleAccountSource,
  type PostingSide,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accountTypeEnum, accounts, journalEntries, journalTypeEnum, money } from './accounting';
import { dimensionColumns, dimensionTypeEnum } from './dimensions';
import { branches, companies } from './organizations';
import { users } from './users';

/*
 * Accounting core extensions: recurring journal templates, prepayment
 * schedules, posting rules and dimension rules. None of these tables holds a
 * balance - every ledger effect is a journal entry written by
 * AccountingPostingService and linked back through source_type / source_id.
 */

export const recurringFrequencyEnum = pgEnum('recurring_frequency', RECURRING_FREQUENCIES);
export const recurringJournalModeEnum = pgEnum('recurring_journal_mode', RECURRING_JOURNAL_MODES);
export const recurringJournalStatusEnum = pgEnum(
  'recurring_journal_status',
  RECURRING_JOURNAL_STATUSES,
);
export const prepaymentStatusEnum = pgEnum('prepayment_status', PREPAYMENT_STATUSES);
export const prepaymentScheduleStatusEnum = pgEnum(
  'prepayment_schedule_status',
  PREPAYMENT_SCHEDULE_STATUSES,
);
export const dimensionRuleScopeEnum = pgEnum('dimension_rule_scope', DIMENSION_RULE_SCOPES);

/** Template line stored on a recurring journal (same shape as a posting line). */
export interface RecurringJournalLine {
  accountId: string;
  debit: string;
  credit: string;
  description?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}

// ---------------------------------------------------------- recurring journals

export const recurringJournals = pgTable(
  'recurring_journals',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    reference: text('reference'),
    journalType: journalTypeEnum('journal_type').notNull().default('GENERAL'),
    frequency: recurringFrequencyEnum('frequency').notNull(),
    interval: integer('interval').notNull().default(1),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    maxOccurrences: integer('max_occurrences'),
    /** Next date an occurrence is due; NULL once the template is exhausted. */
    nextRunDate: date('next_run_date'),
    lastRunDate: date('last_run_date'),
    occurrences: integer('occurrences').notNull().default(0),
    mode: recurringJournalModeEnum('mode').notNull().default('DRAFT'),
    autoReverse: boolean('auto_reverse').notNull().default(false),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    lines: jsonb('lines').$type<RecurringJournalLine[]>().notNull(),
    status: recurringJournalStatusEnum('status').notNull().default('ACTIVE'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Who last approved AUTO_POST mode (must hold journal.post). */
    autoPostApprovedBy: uuid('auto_post_approved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('recurring_journals_company_name_uq').on(t.companyId, t.name),
    index('recurring_journals_due_idx').on(t.companyId, t.status, t.nextRunDate),
    check('recurring_journals_interval_chk', sql`${t.interval} >= 1`),
    check(
      'recurring_journals_range_chk',
      sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

/** One row per generated occurrence; gives the journal its idempotent source identity. */
export const recurringJournalRuns = pgTable(
  'recurring_journal_runs',
  {
    id: primaryId(),
    recurringJournalId: uuid('recurring_journal_id')
      .notNull()
      .references(() => recurringJournals.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    runDate: date('run_date').notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    /** Reversal posted for auto-reversing templates. */
    reversalEntryId: uuid('reversal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recurring_journal_runs_uq').on(t.recurringJournalId, t.runDate),
    index('recurring_journal_runs_company_idx').on(t.companyId, t.runDate),
  ],
);

// ----------------------------------------------------------------- prepayments

export const prepayments = pgTable(
  'prepayments',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    reference: text('reference'),
    prepaidAccountId: uuid('prepaid_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    expenseAccountId: uuid('expense_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    creditAccountId: uuid('credit_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    currency: text('currency').notNull(),
    amount: money('amount').notNull(),
    recognizedAmount: money('recognized_amount').notNull().default('0'),
    startDate: date('start_date').notNull(),
    months: integer('months').notNull(),
    status: prepaymentStatusEnum('status').notNull().default('DRAFT'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    initialEntryId: uuid('initial_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    activatedBy: uuid('activated_by').references(() => users.id, { onDelete: 'set null' }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('prepayments_company_status_idx').on(t.companyId, t.status),
    check('prepayments_amount_chk', sql`${t.amount} > 0`),
    check('prepayments_months_chk', sql`${t.months} BETWEEN 1 AND 120`),
    check(
      'prepayments_recognized_chk',
      sql`${t.recognizedAmount} >= 0 AND ${t.recognizedAmount} <= ${t.amount}`,
    ),
  ],
);

export const prepaymentSchedules = pgTable(
  'prepayment_schedules',
  {
    id: primaryId(),
    prepaymentId: uuid('prepayment_id')
      .notNull()
      .references(() => prepayments.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    recognitionDate: date('recognition_date').notNull(),
    amount: money('amount').notNull(),
    status: prepaymentScheduleStatusEnum('status').notNull().default('PENDING'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    recognizedAt: timestamp('recognized_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('prepayment_schedules_uq').on(t.prepaymentId, t.sequence),
    index('prepayment_schedules_due_idx').on(t.companyId, t.status, t.recognitionDate),
    check('prepayment_schedules_amount_chk', sql`${t.amount} > 0`),
  ],
);

// --------------------------------------------------------------- posting rules

/** A line of a posting rule as stored (validated by `postingRuleLineSchema`). */
export interface PostingRuleLine {
  side: PostingSide;
  accountSource: PostingRuleAccountSource;
  mappingKey?: AccountMappingKey | null;
  accountId?: string | null;
  accountKey?: string | null;
  amountKey: string;
  description?: string | null;
}

/**
 * Declarative Dr / Cr template per transaction type. Modules resolve a rule
 * with their amounts (NET / TAX / GROSS ...) and context accounts and hand the
 * resulting lines to AccountingPostingService - no account ids in code.
 */
export const postingRules = pgTable(
  'posting_rules',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    transactionType: text('transaction_type').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    journalType: journalTypeEnum('journal_type').notNull().default('GENERAL'),
    lines: jsonb('lines').$type<PostingRuleLine[]>().notNull(),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('posting_rules_company_type_uq').on(t.companyId, t.transactionType)],
);

// ------------------------------------------------------------- dimension rules

/** "Account 6100 requires a department": enforced by the posting engine. */
export const dimensionRules = pgTable(
  'dimension_rules',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    scope: dimensionRuleScopeEnum('scope').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    accountType: accountTypeEnum('account_type'),
    codePrefix: text('code_prefix'),
    dimensionType: dimensionTypeEnum('dimension_type').notNull(),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    index('dimension_rules_company_idx').on(t.companyId, t.status),
    check(
      'dimension_rules_scope_chk',
      sql`(${t.scope} = 'ACCOUNT' AND ${t.accountId} IS NOT NULL) OR (${t.scope} = 'ACCOUNT_TYPE' AND ${t.accountType} IS NOT NULL) OR (${t.scope} = 'CODE_PREFIX' AND ${t.codePrefix} IS NOT NULL)`,
    ),
  ],
);

// ------------------------------------------------------------------ relations

export const recurringJournalsRelations = relations(recurringJournals, ({ many }) => ({
  runs: many(recurringJournalRuns),
}));
export const recurringJournalRunsRelations = relations(recurringJournalRuns, ({ one }) => ({
  template: one(recurringJournals, {
    fields: [recurringJournalRuns.recurringJournalId],
    references: [recurringJournals.id],
  }),
}));
export const prepaymentsRelations = relations(prepayments, ({ many }) => ({
  schedules: many(prepaymentSchedules),
}));
export const prepaymentSchedulesRelations = relations(prepaymentSchedules, ({ one }) => ({
  prepayment: one(prepayments, {
    fields: [prepaymentSchedules.prepaymentId],
    references: [prepayments.id],
  }),
}));

export type RecurringJournal = typeof recurringJournals.$inferSelect;
export type RecurringJournalRun = typeof recurringJournalRuns.$inferSelect;
export type Prepayment = typeof prepayments.$inferSelect;
export type PrepaymentSchedule = typeof prepaymentSchedules.$inferSelect;
export type PostingRule = typeof postingRules.$inferSelect;
export type DimensionRule = typeof dimensionRules.$inferSelect;
