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
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  CASH_FLOW_ACTIVITIES,
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
export const cashFlowActivityEnum = pgEnum('cash_flow_activity', CASH_FLOW_ACTIVITIES);

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
    /** Balances are reconciled against an external source (bank, subledger, tax authority). */
    isReconciliation: boolean('is_reconciliation').notNull().default(false),
    /** Cash-flow statement section; NULL = derived from the subtype. */
    cashFlowActivity: cashFlowActivityEnum('cash_flow_activity'),
    /** Accountable person for clearing / reconciling the balance. */
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Branch applicability: empty = every branch may post to the account. */
    allowedBranchIds: uuid('allowed_branch_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
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
    /** Last reopen reason - reopening is never silent. */
    reopenReason: text('reopen_reason'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: uuid('locked_by').references(() => users.id, { onDelete: 'set null' }),
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

/**
 * Running counters: one row per (company, document type, year, branch);
 * `year` is 0 for rules that never reset and `branch_id` NULL for company-wide
 * sequences. Allocation is an atomic upsert inside the document's transaction,
 * so numbers are never reused and a rolled-back document leaves no gap.
 */
export const documentSequences = pgTable(
  'document_sequences',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentType: documentTypeEnum('document_type').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    year: integer('year').notNull(),
    prefix: text('prefix').notNull(),
    nextNumber: integer('next_number').notNull().default(1),
    padding: integer('padding').notNull().default(6),
    ...timestamps,
  },
  (t) => [
    unique('document_sequences_uq')
      .on(t.companyId, t.documentType, t.year, t.branchId)
      .nullsNotDistinct(),
    check('document_sequences_next_chk', sql`${t.nextNumber} >= 1`),
  ],
);

/**
 * Configurable numbering per company, document type and (optionally) branch:
 * prefix, format template (`{PREFIX}-{BRANCH}-{YEAR}-{SEQ}`), padding and
 * whether the counter restarts each fiscal year. Without a rule the engine
 * uses the built-in `<PREFIX>-<YEAR>-<NNNNNN>` default.
 */
export const numberingRules = pgTable(
  'numbering_rules',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentType: documentTypeEnum('document_type').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    prefix: text('prefix').notNull(),
    format: text('format').notNull().default('{PREFIX}-{YEAR}-{SEQ}'),
    padding: integer('padding').notNull().default(6),
    resetYearly: boolean('reset_yearly').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('numbering_rules_uq').on(t.companyId, t.documentType, t.branchId).nullsNotDistinct(),
    check('numbering_rules_padding_chk', sql`${t.padding} BETWEEN 3 AND 12`),
    check('numbering_rules_format_chk', sql`position('{SEQ}' in ${t.format}) > 0`),
  ],
);

export type NumberingRule = typeof numberingRules.$inferSelect;

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
    /** Date on the underlying document, when it differs from the accounting date. */
    documentDate: date('document_date'),
    description: text('description').notNull(),
    reference: text('reference'),
    /** Always the company base currency: every journal line is in base. */
    currency: char('currency', { length: 3 }).notNull(),
    /** Currency the lines were entered in when it differs from base (amounts kept on the lines). */
    transactionCurrency: char('transaction_currency', { length: 3 }),
    /** 1 transaction-currency unit = exchange_rate base units. */
    exchangeRate: numeric('exchange_rate', { precision: 19, scale: 8 }),
    /** Accruals: a mirror REVERSAL is posted on this date when the entry posts. */
    autoReverseDate: date('auto_reverse_date'),
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
    /** For a correcting entry: the posted original it replaces (which was reversed first). */
    correctionOfId: uuid('correction_of_id').references((): AnyPgColumn => journalEntries.id, {
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
    index('journal_entries_correction_idx').on(t.correctionOfId),
    index('journal_entries_source_type_idx').on(t.companyId, t.sourceType),
    check('journal_entries_totals_chk', sql`${t.totalDebit} >= 0 AND ${t.totalCredit} >= 0`),
    check(
      'journal_entries_auto_reverse_chk',
      sql`${t.autoReverseDate} IS NULL OR ${t.autoReverseDate} > ${t.entryDate}`,
    ),
    check(
      'journal_entries_fx_chk',
      sql`(${t.transactionCurrency} IS NULL AND ${t.exchangeRate} IS NULL) OR (${t.transactionCurrency} IS NOT NULL AND ${t.exchangeRate} > 0)`,
    ),
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
    /**
     * Foreign amount beside the base amount, in `foreignCurrency`. Manual foreign
     * journals set it on every line (the header's transaction currency); document
     * postings set it on the lines that hit a currency-bound account (a USD bank
     * account, a USD lease liability), so an account's foreign balance is always
     * the sum of its foreign amounts.
     */
    foreignDebit: money('foreign_debit'),
    foreignCredit: money('foreign_credit'),
    foreignCurrency: char('foreign_currency', { length: 3 }),
    exchangeRate: numeric('exchange_rate', { precision: 19, scale: 8 }),
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
    // Foreign-amount lines are rare: the integrity currency check walks this partial index.
    index('journal_lines_foreign_idx')
      .on(t.companyId, t.journalEntryId)
      .where(sql`${t.foreignDebit} IS NOT NULL OR ${t.foreignCredit} IS NOT NULL`),
    check('journal_lines_non_negative_chk', sql`${t.debit} >= 0 AND ${t.credit} >= 0`),
    check('journal_lines_one_side_chk', sql`${t.debit} = 0 OR ${t.credit} = 0`),
    check('journal_lines_not_empty_chk', sql`${t.debit} > 0 OR ${t.credit} > 0`),
    check(
      'journal_lines_foreign_chk',
      sql`(${t.foreignDebit} IS NULL AND ${t.foreignCredit} IS NULL) OR (${t.foreignDebit} >= 0 AND ${t.foreignCredit} >= 0 AND (${t.foreignDebit} = 0 OR ${t.foreignCredit} = 0))`,
    ),
    check(
      'journal_lines_foreign_currency_chk',
      sql`(${t.foreignCurrency} IS NULL) = (${t.foreignDebit} IS NULL AND ${t.foreignCredit} IS NULL)`,
    ),
    // Foreign balance of a currency-bound account: sum of its foreign amounts.
    index('journal_lines_foreign_currency_idx')
      .on(t.companyId, t.accountId, t.foreignCurrency)
      .where(sql`${t.foreignCurrency} IS NOT NULL`),
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
