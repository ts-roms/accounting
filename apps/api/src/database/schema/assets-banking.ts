import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
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
} from 'drizzle-orm/pg-core';
import {
  ASSET_EVENT_TYPES,
  ASSET_STATUSES,
  BANK_TRANSACTION_STATUSES,
  BANK_TRANSACTION_TYPES,
  DEPRECIATION_METHODS,
  DEPRECIATION_RUN_STATUSES,
  MATCH_CONFIDENCES,
  MATCH_KINDS,
  RECONCILIATION_STATUSES,
  STATEMENT_LINE_STATUSES,
  STATEMENT_STATUSES,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accounts, fiscalPeriods, journalEntries, journalLines, money } from './accounting';
import { branches, companies } from './organizations';
import { vendors } from './subledger';
import { users } from './users';

export const depreciationMethodEnum = pgEnum('depreciation_method', DEPRECIATION_METHODS);
export const assetStatusEnum = pgEnum('asset_status', ASSET_STATUSES);
export const assetEventTypeEnum = pgEnum('asset_event_type', ASSET_EVENT_TYPES);
export const depreciationRunStatusEnum = pgEnum('depreciation_run_status', DEPRECIATION_RUN_STATUSES);
export const bankTransactionTypeEnum = pgEnum('bank_transaction_type', BANK_TRANSACTION_TYPES);
export const bankTransactionStatusEnum = pgEnum('bank_transaction_status', BANK_TRANSACTION_STATUSES);
export const statementStatusEnum = pgEnum('statement_status', STATEMENT_STATUSES);
export const statementLineStatusEnum = pgEnum('statement_line_status', STATEMENT_LINE_STATUSES);
export const matchKindEnum = pgEnum('match_kind', MATCH_KINDS);
export const matchConfidenceEnum = pgEnum('match_confidence', MATCH_CONFIDENCES);
export const reconciliationStatusEnum = pgEnum('reconciliation_status', RECONCILIATION_STATUSES);

// ================================================================ fixed assets

export const assetCategories = pgTable(
  'asset_categories',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    usefulLifeMonths: integer('useful_life_months').notNull().default(60),
    depreciationMethod: depreciationMethodEnum('depreciation_method').notNull().default('STRAIGHT_LINE'),
    decliningRatePercent: money('declining_rate_percent'),
    /** Optional GL overrides; company mappings otherwise. */
    assetAccountId: uuid('asset_account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    accumulatedDepreciationAccountId: uuid('accumulated_depreciation_account_id').references(
      () => accounts.id,
      { onDelete: 'restrict' },
    ),
    depreciationExpenseAccountId: uuid('depreciation_expense_account_id').references(
      () => accounts.id,
      { onDelete: 'restrict' },
    ),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('asset_categories_company_code_uq').on(t.companyId, t.code),
    check('asset_categories_life_chk', sql`${t.usefulLifeMonths} > 0`),
  ],
);

/**
 * The asset register. Cost, accumulated depreciation and book value are
 * maintained here and must agree with the asset / accumulated depreciation
 * accounts in the ledger (every change posts a journal).
 */
export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    assetNumber: text('asset_number').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => assetCategories.id, { onDelete: 'restrict' }),
    status: assetStatusEnum('status').notNull().default('DRAFT'),
    acquisitionDate: date('acquisition_date').notNull(),
    inServiceDate: date('in_service_date').notNull(),
    acquisitionCost: money('acquisition_cost').notNull(),
    salvageValue: money('salvage_value').notNull().default('0'),
    usefulLifeMonths: integer('useful_life_months').notNull(),
    depreciationMethod: depreciationMethodEnum('depreciation_method').notNull(),
    decliningRatePercent: money('declining_rate_percent'),
    /** Carrying figures. cost may change by revaluation; accumulated includes impairment. */
    cost: money('cost').notNull(),
    accumulatedDepreciation: money('accumulated_depreciation').notNull().default('0'),
    /** Months depreciated so far (straight line uses it to compute the remaining schedule). */
    depreciatedMonths: integer('depreciated_months').notNull().default(0),
    location: text('location'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    serialNumber: text('serial_number'),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    reference: text('reference'),
    currency: char('currency', { length: 3 }).notNull(),
    capitalizationJournalEntryId: uuid('capitalization_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    capitalizedAt: timestamp('capitalized_at', { withTimezone: true }),
    disposalDate: date('disposal_date'),
    disposalProceeds: money('disposal_proceeds'),
    disposalGainLoss: money('disposal_gain_loss'),
    disposalJournalEntryId: uuid('disposal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fixed_assets_company_number_uq').on(t.companyId, t.assetNumber),
    uniqueIndex('fixed_assets_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('fixed_assets_company_status_idx').on(t.companyId, t.status),
    check(
      'fixed_assets_amounts_chk',
      sql`${t.acquisitionCost} > 0 AND ${t.salvageValue} >= 0 AND ${t.salvageValue} < ${t.acquisitionCost} AND ${t.cost} >= 0 AND ${t.accumulatedDepreciation} >= 0 AND ${t.accumulatedDepreciation} <= ${t.cost} AND ${t.usefulLifeMonths} > 0`,
    ),
    check('fixed_assets_dates_chk', sql`${t.inServiceDate} >= ${t.acquisitionDate}`),
  ],
);

/** One depreciation posting per fiscal period per company. */
export const depreciationRuns = pgTable(
  'depreciation_runs',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    runNumber: text('run_number').notNull(),
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
    status: depreciationRunStatusEnum('status').notNull().default('DRAFT'),
    runDate: date('run_date').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    totalAmount: money('total_amount').notNull().default('0'),
    assetCount: integer('asset_count').notNull().default(0),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('depreciation_runs_company_number_uq').on(t.companyId, t.runNumber),
    uniqueIndex('depreciation_runs_idempotency_uq').on(t.companyId, t.idempotencyKey),
    // Only one non-reversed run per period.
    uniqueIndex('depreciation_runs_period_uq')
      .on(t.companyId, t.fiscalPeriodId)
      .where(sql`${t.status} <> 'REVERSED'`),
  ],
);

/** Every change to an asset's carrying amount, with its ledger link. */
export const assetEvents = pgTable(
  'asset_events',
  {
    id: primaryId(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => fixedAssets.id, { onDelete: 'cascade' }),
    eventType: assetEventTypeEnum('event_type').notNull(),
    eventDate: date('event_date').notNull(),
    /** Signed effect on accumulated depreciation (+) or cost (revaluation +, disposal -). */
    amount: money('amount').notNull().default('0'),
    bookValueAfter: money('book_value_after').notNull(),
    depreciationRunId: uuid('depreciation_run_id').references(() => depreciationRuns.id, {
      onDelete: 'restrict',
    }),
    fiscalPeriodId: uuid('fiscal_period_id').references(() => fiscalPeriods.id, {
      onDelete: 'restrict',
    }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('asset_events_asset_idx').on(t.assetId, t.eventDate)],
);

export const fixedAssetSettings = pgTable('fixed_asset_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  autoPostDepreciation: boolean('auto_post_depreciation').notNull().default(false),
  ...timestamps,
});

// ===================================================================== banking

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    bankName: text('bank_name'),
    accountNumber: text('account_number'),
    currency: char('currency', { length: 3 }).notNull(),
    /** The cash / bank GL account. The ledger balance of this account is the book balance. */
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('bank_accounts_company_code_uq').on(t.companyId, t.code),
    uniqueIndex('bank_accounts_gl_account_uq').on(t.glAccountId),
  ],
);

/** Deposits, withdrawals, fees, interest and transfers recorded directly against a bank account. */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    transactionType: bankTransactionTypeEnum('transaction_type').notNull(),
    status: bankTransactionStatusEnum('status').notNull().default('DRAFT'),
    transactionDate: date('transaction_date').notNull(),
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    counterpartyAccountId: uuid('counterparty_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    toBankAccountId: uuid('to_bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'restrict',
    }),
    reference: text('reference'),
    memo: text('memo'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    voidReason: text('void_reason'),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('bank_transactions_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('bank_transactions_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('bank_transactions_account_date_idx').on(t.bankAccountId, t.transactionDate),
    check('bank_transactions_amount_chk', sql`${t.amount} > 0`),
    check(
      'bank_transactions_sides_chk',
      sql`(${t.transactionType} = 'TRANSFER' AND ${t.toBankAccountId} IS NOT NULL AND ${t.toBankAccountId} <> ${t.bankAccountId})
        OR (${t.transactionType} <> 'TRANSFER' AND ${t.counterpartyAccountId} IS NOT NULL AND ${t.toBankAccountId} IS NULL)`,
    ),
  ],
);

export const bankStatements = pgTable(
  'bank_statements',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    statementNumber: text('statement_number').notNull(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    status: statementStatusEnum('status').notNull().default('OPEN'),
    statementDate: date('statement_date').notNull(),
    openingBalance: money('opening_balance').notNull(),
    closingBalance: money('closing_balance').notNull(),
    fileName: text('file_name'),
    idempotencyKey: text('idempotency_key'),
    importedBy: uuid('imported_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('bank_statements_company_number_uq').on(t.companyId, t.statementNumber),
    uniqueIndex('bank_statements_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('bank_statements_account_idx').on(t.bankAccountId, t.statementDate),
  ],
);

export const bankStatementLines = pgTable(
  'bank_statement_lines',
  {
    id: primaryId(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatements.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    lineDate: date('line_date').notNull(),
    description: text('description').notNull(),
    reference: text('reference'),
    /** Signed: positive = money in, negative = money out. */
    amount: money('amount').notNull(),
    balance: money('balance'),
    status: statementLineStatusEnum('status').notNull().default('UNMATCHED'),
    matchNote: text('match_note'),
  },
  (t) => [
    uniqueIndex('bank_statement_lines_number_uq').on(t.statementId, t.lineNumber),
    index('bank_statement_lines_status_idx').on(t.statementId, t.status),
    check('bank_statement_lines_amount_chk', sql`${t.amount} <> 0`),
  ],
);

/** A statement line paired with the ledger line it explains. Kept apart from journal_lines (immutable). */
export const bankLineMatches = pgTable(
  'bank_line_matches',
  {
    id: primaryId(),
    statementLineId: uuid('statement_line_id')
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: 'cascade' }),
    journalLineId: uuid('journal_line_id')
      .notNull()
      .references(() => journalLines.id, { onDelete: 'restrict' }),
    kind: matchKindEnum('kind').notNull(),
    reconciliationId: uuid('reconciliation_id'),
    matchedBy: uuid('matched_by').references(() => users.id, { onDelete: 'set null' }),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_line_matches_statement_line_uq').on(t.statementLineId),
    uniqueIndex('bank_line_matches_journal_line_uq').on(t.journalLineId),
  ],
);

export const bankReconciliations = pgTable(
  'bank_reconciliations',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatements.id, { onDelete: 'restrict' }),
    status: reconciliationStatusEnum('status').notNull().default('IN_PROGRESS'),
    statementDate: date('statement_date').notNull(),
    statementBalance: money('statement_balance').notNull(),
    ledgerBalance: money('ledger_balance').notNull(),
    depositsInTransit: money('deposits_in_transit').notNull().default('0'),
    outstandingPayments: money('outstanding_payments').notNull().default('0'),
    unrecordedCredits: money('unrecorded_credits').notNull().default('0'),
    unrecordedDebits: money('unrecorded_debits').notNull().default('0'),
    difference: money('difference').notNull().default('0'),
    completedBy: uuid('completed_by').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [uniqueIndex('bank_reconciliations_statement_uq').on(t.statementId)],
);

export const bankingSettings = pgTable('banking_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  matchDateToleranceDays: integer('match_date_tolerance_days').notNull().default(3),
  autoMatchMinConfidence: matchConfidenceEnum('auto_match_min_confidence').notNull().default('MEDIUM'),
  ...timestamps,
});

export type AssetCategory = typeof assetCategories.$inferSelect;
export type FixedAsset = typeof fixedAssets.$inferSelect;
export type DepreciationRun = typeof depreciationRuns.$inferSelect;
export type AssetEvent = typeof assetEvents.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type BankStatement = typeof bankStatements.$inferSelect;
export type BankStatementLine = typeof bankStatementLines.$inferSelect;
export type BankLineMatch = typeof bankLineMatches.$inferSelect;
export type BankReconciliation = typeof bankReconciliations.$inferSelect;
