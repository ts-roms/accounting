import { sql } from 'drizzle-orm';
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
} from 'drizzle-orm/pg-core';
import {
  LEASE_CLASSIFICATIONS,
  LEASE_EVENT_TYPES,
  LEASE_LINE_STATUSES,
  LEASE_PAYMENT_FREQUENCIES,
  LEASE_PAYMENT_TIMINGS,
  LEASE_RUN_STATUSES,
  LEASE_STATUSES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { assetCategories, bankAccounts } from './assets-banking';
import { dimensionColumns } from './dimensions';
import { branches, companies } from './organizations';
import { vendors } from './subledger';
import { users } from './users';

/*
 * Lease accounting (Prompt #13, lessee side).
 *
 * A lease is captured as data (term, payment, frequency, timing, rate). The
 * pure engine turns the terms into a monthly schedule: interest accretion on
 * the liability, straight-line depreciation of the right-of-use asset and the
 * payments. Commencement posts Dr right-of-use asset / Cr lease liability;
 * lease runs post the interest and depreciation of every pending line up to
 * a period end in one journal; paying a line posts Dr liability / Cr bank.
 * The carrying figures kept here (liability balance, right-of-use cost and
 * accumulated depreciation) must always agree with the ledger - every change
 * posts a journal in the same transaction. Exempt (short-term / low-value)
 * leases keep a payment schedule only and expense each payment as it is paid.
 */

export const leaseClassificationEnum = pgEnum('lease_classification', LEASE_CLASSIFICATIONS);
export const leasePaymentFrequencyEnum = pgEnum(
  'lease_payment_frequency',
  LEASE_PAYMENT_FREQUENCIES,
);
export const leasePaymentTimingEnum = pgEnum('lease_payment_timing', LEASE_PAYMENT_TIMINGS);
export const leaseStatusEnum = pgEnum('lease_status', LEASE_STATUSES);
export const leaseLineStatusEnum = pgEnum('lease_line_status', LEASE_LINE_STATUSES);
export const leaseRunStatusEnum = pgEnum('lease_run_status', LEASE_RUN_STATUSES);
export const leaseEventTypeEnum = pgEnum('lease_event_type', LEASE_EVENT_TYPES);

export const leaseSettings = pgTable('lease_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  /** Term at or below this many months -> SHORT_TERM exemption. */
  shortTermThresholdMonths: integer('short_term_threshold_months').notNull().default(12),
  /** Underlying asset value at or below this -> LOW_VALUE exemption (0 disables). */
  lowValueThreshold: money('low_value_threshold').notNull().default('0'),
  autoPostRuns: boolean('auto_post_runs').notNull().default(false),
  /** Annual incremental borrowing rate (percent) when a contract carries none. */
  defaultDiscountRate: money('default_discount_rate').notNull().default('8'),
  ...timestamps,
});
export type LeaseSettings = typeof leaseSettings.$inferSelect;

export const leases = pgTable(
  'leases',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    leaseNumber: text('lease_number').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    assetCategoryId: uuid('asset_category_id').references(() => assetCategories.id, {
      onDelete: 'restrict',
    }),
    status: leaseStatusEnum('status').notNull().default('DRAFT'),
    classification: leaseClassificationEnum('classification').notNull().default('FINANCE'),
    classificationOverride: leaseClassificationEnum('classification_override'),
    commencementDate: date('commencement_date').notNull(),
    /** Total term in months from commencement (remeasurement may change it). */
    termMonths: integer('term_months').notNull(),
    paymentAmount: money('payment_amount').notNull(),
    paymentFrequency: leasePaymentFrequencyEnum('payment_frequency').notNull().default('MONTHLY'),
    paymentTiming: leasePaymentTimingEnum('payment_timing').notNull().default('IN_ADVANCE'),
    /** Annual discount rate in percent; resolved from settings at commencement when null. */
    annualDiscountRate: money('annual_discount_rate'),
    initialDirectCosts: money('initial_direct_costs').notNull().default('0'),
    leaseIncentives: money('lease_incentives').notNull().default('0'),
    underlyingAssetValue: money('underlying_asset_value'),
    /** Contract currency; the schedule and the carrying figures below are in it. */
    currency: char('currency', { length: 3 }).notNull(),
    /** 1 unit of `currency` = `exchangeRate` base units at commencement (1 for base-currency leases). */
    exchangeRate: numeric('exchange_rate', { precision: 19, scale: 8 }).notNull().default('1'),
    /** Carrying figures - agree with the ledger at all times. */
    initialLiability: money('initial_liability').notNull().default('0'),
    liabilityBalance: money('liability_balance').notNull().default('0'),
    rouCost: money('rou_cost').notNull().default('0'),
    rouAccumulatedDepreciation: money('rou_accumulated_depreciation').notNull().default('0'),
    /**
     * Base-currency carrying figures. The liability is monetary (settled at the
     * rate of each instalment, revalued at period end); the right-of-use asset
     * is not (its base cost is fixed at the commencement rate).
     */
    liabilityBalanceBase: money('liability_balance_base').notNull().default('0'),
    rouCostBase: money('rou_cost_base').notNull().default('0'),
    rouAccumulatedDepreciationBase: money('rou_accumulated_depreciation_base')
      .notNull()
      .default('0'),
    /** Optional GL overrides; company mappings otherwise. */
    rouAssetAccountId: uuid('rou_asset_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    rouAccumulatedAccountId: uuid('rou_accumulated_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    liabilityAccountId: uuid('liability_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    interestExpenseAccountId: uuid('interest_expense_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    depreciationExpenseAccountId: uuid('depreciation_expense_account_id').references(
      () => accounts.id,
      { onDelete: 'restrict' },
    ),
    leaseExpenseAccountId: uuid('lease_expense_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'set null',
    }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    location: text('location'),
    reference: text('reference'),
    commencementJournalEntryId: uuid('commencement_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    commencedAt: timestamp('commenced_at', { withTimezone: true }),
    terminationDate: date('termination_date'),
    terminationGainLoss: money('termination_gain_loss'),
    terminationJournalEntryId: uuid('termination_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('leases_company_number_uq').on(t.companyId, t.leaseNumber),
    index('leases_company_status_idx').on(t.companyId, t.status),
    index('leases_vendor_idx').on(t.vendorId),
    check(
      'leases_amounts_chk',
      sql`${t.paymentAmount} > 0 AND ${t.termMonths} > 0 AND ${t.initialDirectCosts} >= 0 AND ${t.leaseIncentives} >= 0 AND ${t.liabilityBalance} >= 0 AND ${t.rouCost} >= 0 AND ${t.rouAccumulatedDepreciation} >= 0 AND ${t.rouAccumulatedDepreciation} <= ${t.rouCost}`,
    ),
  ],
);
export type Lease = typeof leases.$inferSelect;

/** One lease run posts the interest + depreciation of every pending line up to `periodEnd` in one journal. */
export const leaseRuns = pgTable(
  'lease_runs',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    documentNumber: text('document_number').notNull(),
    periodEnd: date('period_end').notNull(),
    description: text('description'),
    status: leaseRunStatusEnum('status').notNull().default('POSTED'),
    currency: char('currency', { length: 3 }).notNull(),
    interestTotal: money('interest_total').notNull().default('0'),
    depreciationTotal: money('depreciation_total').notNull().default('0'),
    lineCount: integer('line_count').notNull().default(0),
    leaseCount: integer('lease_count').notNull().default(0),
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
    uniqueIndex('lease_runs_company_number_uq').on(t.companyId, t.documentNumber),
    index('lease_runs_company_period_idx').on(t.companyId, t.periodEnd),
  ],
);
export type LeaseRun = typeof leaseRuns.$inferSelect;

/**
 * The monthly schedule. Interest / depreciation belong to the run that
 * posted them; the payment (when the month carries one) is posted by the
 * pay action and recorded on the same line.
 */
export const leaseScheduleLines = pgTable(
  'lease_schedule_lines',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    openingLiability: money('opening_liability').notNull().default('0'),
    interest: money('interest').notNull().default('0'),
    depreciation: money('depreciation').notNull().default('0'),
    /** Base-currency depreciation, fixed at the commencement rate (sums to the ROU base cost). */
    depreciationBase: money('depreciation_base').notNull().default('0'),
    /** Base-currency interest at the rate of the run that posted it; null while pending. */
    interestBase: money('interest_base'),
    /** Zero for months without a payment. */
    payment: money('payment').notNull().default('0'),
    paymentDate: date('payment_date'),
    closingLiability: money('closing_liability').notNull().default('0'),
    status: leaseLineStatusEnum('status').notNull().default('PENDING'),
    runId: uuid('run_id').references(() => leaseRuns.id, { onDelete: 'set null' }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidDate: date('paid_date'),
    paidBankAccountId: uuid('paid_bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'restrict',
    }),
    paymentJournalEntryId: uuid('payment_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (t) => [
    index('lease_schedule_lines_lease_idx').on(t.leaseId, t.sequence),
    index('lease_schedule_lines_status_idx').on(t.companyId, t.status, t.periodEnd),
    index('lease_schedule_lines_run_idx').on(t.runId),
    check(
      'lease_schedule_lines_amounts_chk',
      sql`${t.interest} >= 0 AND ${t.depreciation} >= 0 AND ${t.payment} >= 0`,
    ),
  ],
);
export type LeaseScheduleLine = typeof leaseScheduleLines.$inferSelect;

/** Every change to a lease's carrying amounts, with its ledger link. */
export const leaseEvents = pgTable(
  'lease_events',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    leaseId: uuid('lease_id')
      .notNull()
      .references(() => leases.id, { onDelete: 'cascade' }),
    eventType: leaseEventTypeEnum('event_type').notNull(),
    eventDate: date('event_date').notNull(),
    /** Signed change to the liability (+ accretion / remeasurement up, - payment / derecognition). */
    liabilityChange: money('liability_change').notNull().default('0'),
    /** Signed change to the right-of-use carrying amount. */
    rouChange: money('rou_change').notNull().default('0'),
    /** The same effects in the company base currency - what the ledger carries. */
    liabilityChangeBase: money('liability_change_base').notNull().default('0'),
    rouChangeBase: money('rou_change_base').notNull().default('0'),
    liabilityAfter: money('liability_after').notNull().default('0'),
    rouCarryingAfter: money('rou_carrying_after').notNull().default('0'),
    runId: uuid('run_id').references(() => leaseRuns.id, { onDelete: 'set null' }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('lease_events_lease_idx').on(t.leaseId, t.eventDate)],
);
export type LeaseEvent = typeof leaseEvents.$inferSelect;
