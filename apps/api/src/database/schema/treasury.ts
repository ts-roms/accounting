import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  BANK_ACCOUNT_TYPES,
  BANK_TRANSFER_PURPOSES,
  BANK_TRANSFER_STATUSES,
  DEFAULT_COLLECTION_PROBABILITIES,
  DEFAULT_SCENARIOS,
  FORECAST_GRANULARITIES,
  FORECAST_ITEM_DIRECTIONS,
  FORECAST_ITEM_FREQUENCIES,
  FORECAST_SCENARIOS,
  PAYMENT_FILE_FORMATS,
  PAYMENT_FILE_STATUSES,
  PETTY_CASH_FUND_STATUSES,
  PETTY_CASH_VOUCHER_STATUSES,
  type CollectionProbabilities,
  type ForecastScenario,
  type ScenarioAdjustments,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { bankAccounts, bankTransactions } from './assets-banking';
import { dimensionColumns } from './dimensions';
import { rate } from './enterprise';
import { branches, companies } from './organizations';
import { paymentRuns } from './payables';
import { vendorPayments } from './subledger';
import { taxCodes } from './tax';
import { users } from './users';

export const bankAccountTypeEnum = pgEnum('bank_account_type', BANK_ACCOUNT_TYPES);
export const paymentFileFormatEnum = pgEnum('payment_file_format', PAYMENT_FILE_FORMATS);
export const paymentFileStatusEnum = pgEnum('payment_file_status', PAYMENT_FILE_STATUSES);
export const bankTransferStatusEnum = pgEnum('bank_transfer_status', BANK_TRANSFER_STATUSES);
export const bankTransferPurposeEnum = pgEnum('bank_transfer_purpose', BANK_TRANSFER_PURPOSES);
export const pettyCashFundStatusEnum = pgEnum('petty_cash_fund_status', PETTY_CASH_FUND_STATUSES);
export const pettyCashVoucherStatusEnum = pgEnum(
  'petty_cash_voucher_status',
  PETTY_CASH_VOUCHER_STATUSES,
);
export const forecastGranularityEnum = pgEnum('forecast_granularity', FORECAST_GRANULARITIES);
export const forecastScenarioEnum = pgEnum('forecast_scenario', FORECAST_SCENARIOS);
export const forecastItemFrequencyEnum = pgEnum(
  'forecast_item_frequency',
  FORECAST_ITEM_FREQUENCIES,
);
export const forecastItemDirectionEnum = pgEnum(
  'forecast_item_direction',
  FORECAST_ITEM_DIRECTIONS,
);

// ------------------------------------------------------------------ settings

export const treasurySettings = pgTable('treasury_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  forecastHorizonDays: integer('forecast_horizon_days').notNull().default(90),
  forecastGranularity: forecastGranularityEnum('forecast_granularity').notNull().default('WEEK'),
  collectionProbabilities: jsonb('collection_probabilities')
    .$type<CollectionProbabilities>()
    .notNull()
    .default(DEFAULT_COLLECTION_PROBABILITIES),
  scenarios: jsonb('scenarios')
    .$type<Record<ForecastScenario, ScenarioAdjustments>>()
    .notNull()
    .default(DEFAULT_SCENARIOS),
  minimumDaysCashOnHand: integer('minimum_days_cash_on_hand').notNull().default(30),
  burnWindowDays: integer('burn_window_days').notNull().default(90),
  transferApprovalThreshold: money('transfer_approval_threshold'),
  unsettledTransferWarnDays: integer('unsettled_transfer_warn_days').notNull().default(2),
  defaultPaymentFileFormat: paymentFileFormatEnum('default_payment_file_format')
    .notNull()
    .default('PESONET_CSV'),
  originatorName: text('originator_name'),
  pettyCashVoucherLimit: money('petty_cash_voucher_limit'),
  ...timestamps,
});

/** Treasury attributes of a bank account; one row per account, created on first use. */
export const bankAccountProfiles = pgTable('bank_account_profiles', {
  bankAccountId: uuid('bank_account_id')
    .primaryKey()
    .references(() => bankAccounts.id, { onDelete: 'cascade' }),
  accountType: bankAccountTypeEnum('account_type').notNull().default('CURRENT'),
  purpose: text('purpose'),
  minimumBalance: money('minimum_balance'),
  targetBalance: money('target_balance'),
  overdraftLimit: money('overdraft_limit'),
  routingCode: text('routing_code'),
  paymentFileFormat: paymentFileFormatEnum('payment_file_format'),
  originatorId: text('originator_id'),
  isDefaultReceipts: boolean('is_default_receipts').notNull().default(false),
  isDefaultPayments: boolean('is_default_payments').notNull().default(false),
  signatories: text('signatories'),
  excludeFromPosition: boolean('exclude_from_position').notNull().default(false),
  ...timestamps,
});

// ------------------------------------------------------------ bank transfers

/**
 * Inter-account transfer settled in two legs through CASH_IN_TRANSIT so a
 * transfer in flight never overstates either bank balance.
 */
export const bankTransfers = pgTable(
  'bank_transfers',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    status: bankTransferStatusEnum('status').notNull().default('DRAFT'),
    purpose: bankTransferPurposeEnum('purpose').notNull().default('FUNDING'),
    fromBankAccountId: uuid('from_bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    toBankAccountId: uuid('to_bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    transferDate: date('transfer_date').notNull(),
    expectedSettlementDate: date('expected_settlement_date').notNull(),
    settlementDate: date('settlement_date'),
    /** Amount leaving the source, in the source currency. */
    amount: money('amount').notNull(),
    fromCurrency: char('from_currency', { length: 3 }).notNull(),
    /** Amount arriving at the destination, in its currency (equals amount for same-currency transfers). */
    receivedAmount: money('received_amount').notNull(),
    toCurrency: char('to_currency', { length: 3 }).notNull(),
    /** Base-currency value of the out leg; the in leg differs by the FX difference. */
    baseAmount: money('base_amount').notNull().default('0'),
    fxDifference: money('fx_difference').notNull().default('0'),
    feeAmount: money('fee_amount').notNull().default('0'),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    reference: text('reference'),
    bankReference: text('bank_reference'),
    memo: text('memo'),
    outJournalEntryId: uuid('out_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    inJournalEntryId: uuid('in_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    settledBy: uuid('settled_by').references(() => users.id, { onDelete: 'set null' }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('bank_transfers_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('bank_transfers_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('bank_transfers_company_status_idx').on(t.companyId, t.status),
    index('bank_transfers_from_idx').on(t.fromBankAccountId),
    index('bank_transfers_to_idx').on(t.toBankAccountId),
    check(
      'bank_transfers_amount_chk',
      sql`${t.amount} > 0 AND ${t.receivedAmount} > 0 AND ${t.feeAmount} >= 0`,
    ),
    check('bank_transfers_accounts_chk', sql`${t.fromBankAccountId} <> ${t.toBankAccountId}`),
  ],
);

// ------------------------------------------------------------- payment files

/** A bank batch file produced from posted vendor payments. Never posts. */
export const paymentFiles = pgTable(
  'payment_files',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    status: paymentFileStatusEnum('status').notNull().default('GENERATED'),
    format: paymentFileFormatEnum('format').notNull(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    paymentRunId: uuid('payment_run_id').references(() => paymentRuns.id, { onDelete: 'set null' }),
    valueDate: date('value_date').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    totalAmount: money('total_amount').notNull().default('0'),
    paymentCount: integer('payment_count').notNull().default(0),
    filename: text('filename').notNull(),
    /** The generated file content (text formats only). */
    content: text('content').notNull(),
    /** SHA-256 of the content, written into the file trailer where the format allows. */
    checksum: text('checksum').notNull(),
    description: text('description'),
    bankReference: text('bank_reference'),
    statusNote: text('status_note'),
    transmittedBy: uuid('transmitted_by').references(() => users.id, { onDelete: 'set null' }),
    transmittedAt: timestamp('transmitted_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payment_files_company_number_uq').on(t.companyId, t.documentNumber),
    index('payment_files_company_status_idx').on(t.companyId, t.status),
    index('payment_files_bank_idx').on(t.bankAccountId),
  ],
);

export const paymentFileLines = pgTable(
  'payment_file_lines',
  {
    id: primaryId(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => paymentFiles.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => vendorPayments.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    amount: money('amount').notNull(),
    beneficiaryName: text('beneficiary_name').notNull(),
    beneficiaryBank: text('beneficiary_bank'),
    /** Full account number as written to the file. */
    beneficiaryAccount: text('beneficiary_account'),
    beneficiaryRouting: text('beneficiary_routing'),
    remittanceInfo: text('remittance_info'),
  },
  (t) => [
    // A posted payment belongs to at most one live file (cancelled / rejected files are excluded in code).
    index('payment_file_lines_payment_idx').on(t.paymentId),
    index('payment_file_lines_file_idx').on(t.fileId),
  ],
);

// ---------------------------------------------------------------- petty cash

export const pettyCashFunds = pgTable(
  'petty_cash_funds',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: pettyCashFundStatusEnum('status').notNull().default('ACTIVE'),
    /** Cash-on-hand GL account dedicated to the fund; its balance is the book cash. */
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    imprestAmount: money('imprest_amount').notNull(),
    custodianId: uuid('custodian_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    voucherApprovalLimit: money('voucher_approval_limit'),
    replenishAtPercent: money('replenish_at_percent').notNull().default('25'),
    lastReplenishedAt: date('last_replenished_at'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('petty_cash_funds_company_code_uq').on(t.companyId, t.code),
    uniqueIndex('petty_cash_funds_gl_account_uq').on(t.glAccountId),
    check('petty_cash_funds_imprest_chk', sql`${t.imprestAmount} > 0`),
  ],
);

export const pettyCashVouchers = pgTable(
  'petty_cash_vouchers',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    fundId: uuid('fund_id')
      .notNull()
      .references(() => pettyCashFunds.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    status: pettyCashVoucherStatusEnum('status').notNull().default('DRAFT'),
    voucherDate: date('voucher_date').notNull(),
    payee: text('payee').notNull(),
    description: text('description'),
    receiptReference: text('receipt_reference'),
    total: money('total').notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    /** Replenishment (bank transaction) that reimbursed this voucher. */
    replenishmentId: uuid('replenishment_id').references((): AnyPgColumn => bankTransactions.id, {
      onDelete: 'set null',
    }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('petty_cash_vouchers_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('petty_cash_vouchers_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('petty_cash_vouchers_fund_idx').on(t.fundId, t.status),
    check('petty_cash_vouchers_total_chk', sql`${t.total} >= 0`),
  ],
);

export const pettyCashVoucherLines = pgTable(
  'petty_cash_voucher_lines',
  {
    id: primaryId(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => pettyCashVouchers.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    description: text('description').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amount: money('amount').notNull(),
    taxCodeId: uuid('tax_code_id').references((): AnyPgColumn => taxCodes.id, {
      onDelete: 'set null',
    }),
    ...dimensionColumns(),
  },
  (t) => [
    index('petty_cash_voucher_lines_voucher_idx').on(t.voucherId),
    check('petty_cash_voucher_lines_amount_chk', sql`${t.amount} > 0`),
  ],
);

// ------------------------------------------------------------------ forecast

/** Planned cash flows treasury maintains by hand (payroll, rent, loans, taxes ...). */
export const cashForecastItems = pgTable(
  'cash_forecast_items',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    direction: forecastItemDirectionEnum('direction').notNull(),
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    frequency: forecastItemFrequencyEnum('frequency').notNull().default('MONTHLY'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'set null',
    }),
    category: text('category'),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('cash_forecast_items_company_idx').on(t.companyId, t.active),
    check('cash_forecast_items_amount_chk', sql`${t.amount} > 0`),
  ],
);

/** A saved forecast run, kept so forecast accuracy can be measured against actuals later. */
export const cashForecastSnapshots = pgTable(
  'cash_forecast_snapshots',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    asOf: date('as_of').notNull(),
    horizonDays: integer('horizon_days').notNull(),
    granularity: forecastGranularityEnum('granularity').notNull(),
    scenario: forecastScenarioEnum('scenario').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    openingCash: money('opening_cash').notNull(),
    closingCash: money('closing_cash').notNull(),
    minimumCash: money('minimum_cash').notNull(),
    totalInflows: money('total_inflows').notNull(),
    totalOutflows: money('total_outflows').notNull(),
    /** The bucket table as returned by the API. */
    buckets: jsonb('buckets').$type<unknown[]>().notNull(),
    breaches: integer('breaches').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('cash_forecast_snapshots_company_idx').on(t.companyId, t.asOf)],
);

export type TreasurySettingsRow = typeof treasurySettings.$inferSelect;
export type BankAccountProfile = typeof bankAccountProfiles.$inferSelect;
export type BankTransfer = typeof bankTransfers.$inferSelect;
export type PaymentFile = typeof paymentFiles.$inferSelect;
export type PaymentFileLine = typeof paymentFileLines.$inferSelect;
export type PettyCashFund = typeof pettyCashFunds.$inferSelect;
export type PettyCashVoucher = typeof pettyCashVouchers.$inferSelect;
export type PettyCashVoucherLine = typeof pettyCashVoucherLines.$inferSelect;
export type CashForecastItem = typeof cashForecastItems.$inferSelect;
export type CashForecastSnapshot = typeof cashForecastSnapshots.$inferSelect;
