import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  DOCUMENT_TYPES,
  FISCAL_PERIOD_STATUSES,
  FISCAL_YEAR_STATUSES,
  JOURNAL_STATUSES,
  JOURNAL_TYPES,
  NORMAL_BALANCES,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { dimensionColumns } from './dimensions';
import { branches, companies } from './organizations';
import { users } from './users';

export const accountTypeEnum = pgEnum('account_type', ACCOUNT_TYPES);
export const accountSubtypeEnum = pgEnum('account_subtype', ACCOUNT_SUBTYPES);
export const normalBalanceEnum = pgEnum('normal_balance', NORMAL_BALANCES);
export const journalStatusEnum = pgEnum('journal_status', JOURNAL_STATUSES);
export const journalTypeEnum = pgEnum('journal_type', JOURNAL_TYPES);
export const fiscalPeriodStatusEnum = pgEnum('fiscal_period_status', FISCAL_PERIOD_STATUSES);
export const fiscalYearStatusEnum = pgEnum('fiscal_year_status', FISCAL_YEAR_STATUSES);
export const accountMappingKeyEnum = pgEnum('account_mapping_key', ACCOUNT_MAPPING_KEYS);
export const documentTypeEnum = pgEnum('document_type', DOCUMENT_TYPES);

/** Monetary column: NUMERIC(19,4), never float. Read back as a decimal string. */
export const money = (name: string) => numeric(name, { precision: 19, scale: 4 });

// ------------------------------------------------------------- chart of accounts

export const accounts = pgTable(
  'accounts',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    subtype: accountSubtypeEnum('subtype'),
    normalBalance: normalBalanceEnum('normal_balance').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id, {
      onDelete: 'restrict',
    }),
    /** Header (summary) accounts group children and cannot be posted to. */
    isHeader: boolean('is_header').notNull().default(false),
    /** Intercompany balances are eliminated in consolidated reports (Phase 8). */
    isIntercompany: boolean('is_intercompany').notNull().default(false),
    /** System accounts are required by the engine (e.g. retained earnings) and cannot be deactivated. */
    isSystem: boolean('is_system').notNull().default(false),
    /** NULL = the company's functional currency. */
    currency: char('currency', { length: 3 }),
    description: text('description'),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_company_code_uq').on(t.companyId, t.code),
    index('accounts_company_type_idx').on(t.companyId, t.type),
    index('accounts_parent_idx').on(t.parentId),
  ],
);

export const accountMappings = pgTable(
  'account_mappings',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    key: accountMappingKeyEnum('key').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('account_mappings_company_key_uq').on(t.companyId, t.key)],
);

// --------------------------------------------------------------- fiscal calendar

export const fiscalYears = pgTable(
  'fiscal_years',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: fiscalYearStatusEnum('status').notNull().default('OPEN'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fiscal_years_company_name_uq').on(t.companyId, t.name),
    uniqueIndex('fiscal_years_company_start_uq').on(t.companyId, t.startDate),
    check('fiscal_years_range_chk', sql`${t.endDate} > ${t.startDate}`),
  ],
);

export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: primaryId(),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    periodNumber: integer('period_number').notNull(),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: fiscalPeriodStatusEnum('status').notNull().default('OPEN'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: uuid('reopened_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fiscal_periods_year_number_uq').on(t.fiscalYearId, t.periodNumber),
    index('fiscal_periods_company_dates_idx').on(t.companyId, t.startDate, t.endDate),
    check('fiscal_periods_range_chk', sql`${t.endDate} >= ${t.startDate}`),
    check('fiscal_periods_number_chk', sql`${t.periodNumber} BETWEEN 1 AND 13`),
  ],
);

// ---------------------------------------------------------------- numbering

/** One row per (company, document type, fiscal year); allocated under a row lock. */
export const documentSequences = pgTable(
  'document_sequences',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentType: documentTypeEnum('document_type').notNull(),
    year: integer('year').notNull(),
    prefix: text('prefix').notNull(),
    nextNumber: integer('next_number').notNull().default(1),
    padding: integer('padding').notNull().default(6),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('document_sequences_uq').on(t.companyId, t.documentType, t.year),
    check('document_sequences_next_chk', sql`${t.nextNumber} >= 1`),
  ],
);

// ------------------------------------------------------------------ journals

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    journalType: journalTypeEnum('journal_type').notNull().default('GENERAL'),
    status: journalStatusEnum('status').notNull().default('DRAFT'),
    /** Date of the business event (drives the fiscal period). */
    entryDate: date('entry_date').notNull(),
    /** Set when posted; equals entry_date unless a later posting date is chosen. */
    postingDate: date('posting_date'),
    description: text('description').notNull(),
    reference: text('reference'),
    currency: char('currency', { length: 3 }).notNull(),
    totalDebit: money('total_debit').notNull().default('0'),
    totalCredit: money('total_credit').notNull().default('0'),
    /** Origin document for entries generated by other modules (Phase 3+). */
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    idempotencyKey: text('idempotency_key'),
    reversalOfId: uuid('reversal_of_id').references((): AnyPgColumn => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversedById: uuid('reversed_by_id').references((): AnyPgColumn => journalEntries.id, {
      onDelete: 'restrict',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    submittedBy: uuid('submitted_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => users.id, { onDelete: 'set null' }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('journal_entries_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('journal_entries_idempotency_uq').on(t.companyId, t.idempotencyKey),
    uniqueIndex('journal_entries_source_uq').on(t.companyId, t.sourceType, t.sourceId),
    index('journal_entries_company_date_idx').on(t.companyId, t.entryDate),
    index('journal_entries_period_idx').on(t.fiscalPeriodId),
    index('journal_entries_status_idx').on(t.companyId, t.status),
    check('journal_entries_totals_chk', sql`${t.totalDebit} >= 0 AND ${t.totalCredit} >= 0`),
    // Posted documents must be balanced - enforced again in code with exact decimals.
    check(
      'journal_entries_posted_balanced_chk',
      sql`${t.status} IN ('DRAFT','SUBMITTED','REJECTED') OR ${t.totalDebit} = ${t.totalCredit}`,
    ),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: primaryId(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    /** Denormalised for ledger queries (always equals the parent's company). */
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    description: text('description'),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    /** Cost-accounting dimensions (Phase 7). */
    ...dimensionColumns(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('journal_lines_entry_number_uq').on(t.journalEntryId, t.lineNumber),
    index('journal_lines_department_idx').on(t.companyId, t.departmentId),
    index('journal_lines_cost_center_idx').on(t.companyId, t.costCenterId),
    index('journal_lines_project_idx').on(t.companyId, t.projectId),
    index('journal_lines_account_idx').on(t.companyId, t.accountId),
    index('journal_lines_entry_idx').on(t.journalEntryId),
    check('journal_lines_non_negative_chk', sql`${t.debit} >= 0 AND ${t.credit} >= 0`),
    check('journal_lines_one_side_chk', sql`${t.debit} = 0 OR ${t.credit} = 0`),
    check('journal_lines_not_empty_chk', sql`${t.debit} > 0 OR ${t.credit} > 0`),
  ],
);

// ------------------------------------------------------------------ relations

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  company: one(companies, { fields: [accounts.companyId], references: [companies.id] }),
  parent: one(accounts, {
    fields: [accounts.parentId],
    references: [accounts.id],
    relationName: 'children',
  }),
  children: many(accounts, { relationName: 'children' }),
  lines: many(journalLines),
}));

export const fiscalYearsRelations = relations(fiscalYears, ({ many }) => ({
  periods: many(fiscalPeriods),
}));
export const fiscalPeriodsRelations = relations(fiscalPeriods, ({ one, many }) => ({
  fiscalYear: one(fiscalYears, {
    fields: [fiscalPeriods.fiscalYearId],
    references: [fiscalYears.id],
  }),
  entries: many(journalEntries),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  company: one(companies, { fields: [journalEntries.companyId], references: [companies.id] }),
  fiscalPeriod: one(fiscalPeriods, {
    fields: [journalEntries.fiscalPeriodId],
    references: [fiscalPeriods.id],
  }),
  lines: many(journalLines),
  reversalOf: one(journalEntries, {
    fields: [journalEntries.reversalOfId],
    references: [journalEntries.id],
    relationName: 'reversal',
  }),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, {
    fields: [journalLines.journalEntryId],
    references: [journalEntries.id],
  }),
  account: one(accounts, { fields: [journalLines.accountId], references: [accounts.id] }),
}));

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type AccountMapping = typeof accountMappings.$inferSelect;
export type FiscalYear = typeof fiscalYears.$inferSelect;
export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type DocumentSequence = typeof documentSequences.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
