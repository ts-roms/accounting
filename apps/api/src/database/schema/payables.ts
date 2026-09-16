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
  AP_ACCRUAL_SOURCES,
  AP_ACCRUAL_STATUSES,
  BILL_HOLD_REASONS,
  BILL_HOLD_STATUSES,
  DEFAULT_AGING_BUCKETS,
  DEFAULT_CASH_REQUIREMENT_HORIZONS,
  PAYMENT_RUN_LINE_STATUSES,
  PAYMENT_RUN_SELECTION_MODES,
  PAYMENT_RUN_STATUSES,
  VENDOR_ADDRESS_TYPES,
  VENDOR_HOLD_REASONS,
  VENDOR_RISK_RATINGS,
  VENDOR_STATUSES,
  VENDOR_TYPES,
  type AgingBucketDefinition,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { dimensionColumns } from './dimensions';
import { orderLines, orders } from './orders';
import { branches, companies } from './organizations';
import { paymentMethodEnum, paymentTerms } from './receivables';
import { vendorBills, vendorPayments, vendors } from './subledger';
import { taxCodes } from './tax';
import { users } from './users';

export const vendorTypeEnum = pgEnum('vendor_type', VENDOR_TYPES);
export const vendorStatusEnum = pgEnum('vendor_status', VENDOR_STATUSES);
export const vendorAddressTypeEnum = pgEnum('vendor_address_type', VENDOR_ADDRESS_TYPES);
export const vendorRiskRatingEnum = pgEnum('vendor_risk_rating', VENDOR_RISK_RATINGS);
export const vendorHoldReasonEnum = pgEnum('vendor_hold_reason', VENDOR_HOLD_REASONS);
export const billHoldReasonEnum = pgEnum('bill_hold_reason', BILL_HOLD_REASONS);
export const billHoldStatusEnum = pgEnum('bill_hold_status', BILL_HOLD_STATUSES);
export const paymentRunStatusEnum = pgEnum('payment_run_status', PAYMENT_RUN_STATUSES);
export const paymentRunLineStatusEnum = pgEnum(
  'payment_run_line_status',
  PAYMENT_RUN_LINE_STATUSES,
);
export const paymentRunSelectionModeEnum = pgEnum(
  'payment_run_selection_mode',
  PAYMENT_RUN_SELECTION_MODES,
);
export const apAccrualStatusEnum = pgEnum('ap_accrual_status', AP_ACCRUAL_STATUSES);
export const apAccrualSourceEnum = pgEnum('ap_accrual_source', AP_ACCRUAL_SOURCES);

// ----------------------------------------------------------------- policy

export const vendorGroups = pgTable(
  'vendor_groups',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    defaultPaymentTermId: uuid('default_payment_term_id').references(() => paymentTerms.id, {
      onDelete: 'set null',
    }),
    defaultWithholdingTaxCodeId: uuid('default_withholding_tax_code_id').references(
      (): AnyPgColumn => taxCodes.id,
      { onDelete: 'set null' },
    ),
    defaultExpenseAccountId: uuid('default_expense_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    requireBillApproval: boolean('require_bill_approval').notNull().default(false),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('vendor_groups_company_code_uq').on(t.companyId, t.code)],
);

/** One row per company; created on first read with the defaults below. */
export const apSettings = pgTable('ap_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  agingBuckets: jsonb('aging_buckets')
    .$type<AgingBucketDefinition[]>()
    .notNull()
    .default([...DEFAULT_AGING_BUCKETS]),
  dpoWindowDays: integer('dpo_window_days').notNull().default(90),
  cashRequirementHorizons: jsonb('cash_requirement_horizons')
    .$type<number[]>()
    .notNull()
    .default([...DEFAULT_CASH_REQUIREMENT_HORIZONS]),
  dueSoonDays: integer('due_soon_days').notNull().default(7),
  discountWarnDays: integer('discount_warn_days').notNull().default(3),
  grniAgeWarnDays: integer('grni_age_warn_days').notNull().default(30),
  requirePaymentApproval: boolean('require_payment_approval').notNull().default(false),
  requireRunApproval: boolean('require_run_approval').notNull().default(true),
  billApprovalThreshold: money('bill_approval_threshold'),
  requireVendorApproval: boolean('require_vendor_approval').notNull().default(false),
  requirePoForStockBills: boolean('require_po_for_stock_bills').notNull().default(false),
  blockDuplicateVendorInvoice: boolean('block_duplicate_vendor_invoice').notNull().default(false),
  defaultPaymentTermId: uuid('default_payment_term_id').references(() => paymentTerms.id, {
    onDelete: 'set null',
  }),
  defaultCashAccountId: uuid('default_cash_account_id').references(() => accounts.id, {
    onDelete: 'set null',
  }),
  ...timestamps,
});

// ------------------------------------------------------------ vendor master

export const vendorContacts = pgTable(
  'vendor_contacts',
  {
    id: primaryId(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title'),
    role: text('role'),
    email: text('email'),
    phone: text('phone'),
    isPrimary: boolean('is_primary').notNull().default(false),
    receivesRemittance: boolean('receives_remittance').notNull().default(false),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [index('vendor_contacts_vendor_idx').on(t.vendorId)],
);

export const vendorAddresses = pgTable(
  'vendor_addresses',
  {
    id: primaryId(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    addressType: vendorAddressTypeEnum('address_type').notNull(),
    label: text('label'),
    attention: text('attention'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    province: text('province'),
    postalCode: text('postal_code'),
    country: char('country', { length: 2 }).notNull().default('PH'),
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps,
  },
  (t) => [index('vendor_addresses_vendor_idx').on(t.vendorId, t.addressType)],
);

/**
 * Settlement instructions. The full account number is stored for payment
 * files; the API only ever exposes `accountNumberMasked`.
 */
export const vendorBankAccounts = pgTable(
  'vendor_bank_accounts',
  {
    id: primaryId(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    bankName: text('bank_name').notNull(),
    label: text('label'),
    accountName: text('account_name').notNull(),
    accountNumber: text('account_number').notNull(),
    routingCode: text('routing_code'),
    currency: char('currency', { length: 3 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    notes: text('notes'),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [index('vendor_bank_accounts_vendor_idx').on(t.vendorId)],
);

/**
 * Procurement / compliance state per vendor. Approval and hold flags live on
 * `vendors.vendorStatus` (one source); this row carries the hold trail, the
 * risk rating and the payment preferences.
 */
export const vendorProfiles = pgTable('vendor_profiles', {
  vendorId: uuid('vendor_id')
    .primaryKey()
    .references(() => vendors.id, { onDelete: 'cascade' }),
  riskRating: vendorRiskRatingEnum('risk_rating').notNull().default('LOW'),
  paymentMethod: paymentMethodEnum('payment_method').notNull().default('BANK_TRANSFER'),
  minimumPaymentAmount: money('minimum_payment_amount'),
  requireBillApproval: boolean('require_bill_approval').notNull().default(false),
  allowBillsWithoutPo: boolean('allow_bills_without_po').notNull().default(true),
  holdReason: vendorHoldReasonEnum('hold_reason'),
  holdNote: text('hold_note'),
  holdBy: uuid('hold_by').references(() => users.id, { onDelete: 'set null' }),
  holdAt: timestamp('hold_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  reviewDate: date('review_date'),
  notes: text('notes'),
  ...timestamps,
});

// ----------------------------------------------------------------- bill holds

/** A payment hold on a bill: the bill stays posted but no payment run may select it. */
export const billHolds = pgTable(
  'bill_holds',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => vendorBills.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    status: billHoldStatusEnum('status').notNull().default('ACTIVE'),
    reason: billHoldReasonEnum('reason').notNull(),
    note: text('note'),
    placedBy: uuid('placed_by').references(() => users.id, { onDelete: 'set null' }),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
    releasedBy: uuid('released_by').references(() => users.id, { onDelete: 'set null' }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseNote: text('release_note'),
    ...timestamps,
  },
  (t) => [
    index('bill_holds_bill_idx').on(t.billId, t.status),
    index('bill_holds_company_status_idx').on(t.companyId, t.status),
  ],
);

// --------------------------------------------------------------- payment runs

export const paymentRuns = pgTable(
  'payment_runs',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    status: paymentRunStatusEnum('status').notNull().default('DRAFT'),
    cashAccountId: uuid('cash_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    currency: char('currency', { length: 3 }).notNull(),
    paymentDate: date('payment_date').notNull(),
    payThroughDate: date('pay_through_date').notNull(),
    selectionMode: paymentRunSelectionModeEnum('selection_mode')
      .notNull()
      .default('DUE_OR_DISCOUNT'),
    method: paymentMethodEnum('method').notNull().default('BANK_TRANSFER'),
    vendorGroupId: uuid('vendor_group_id').references(() => vendorGroups.id, {
      onDelete: 'set null',
    }),
    /** Proposal filters as submitted (vendor ids, explicit bill ids). */
    filters: jsonb('filters')
      .$type<{ vendorIds?: string[]; billIds?: string[] }>()
      .notNull()
      .default({}),
    maximumAmount: money('maximum_amount'),
    description: text('description'),
    /** Cash to be paid = sum of selected line amounts. */
    totalAmount: money('total_amount').notNull().default('0'),
    totalDiscount: money('total_discount').notNull().default('0'),
    lineCount: integer('line_count').notNull().default(0),
    vendorCount: integer('vendor_count').notNull().default(0),
    submittedBy: uuid('submitted_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvalNote: text('approval_note'),
    executedBy: uuid('executed_by').references(() => users.id, { onDelete: 'set null' }),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payment_runs_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('payment_runs_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('payment_runs_company_status_idx').on(t.companyId, t.status),
    index('payment_runs_company_date_idx').on(t.companyId, t.paymentDate),
  ],
);

export const paymentRunLines = pgTable(
  'payment_run_lines',
  {
    id: primaryId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => paymentRuns.id, { onDelete: 'cascade' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => vendorBills.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    status: paymentRunLineStatusEnum('status').notNull().default('SELECTED'),
    /** Open balance of the bill when proposed. */
    openAmount: money('open_amount').notNull(),
    /** Early-payment discount available on the run's payment date. */
    discountAvailable: money('discount_available').notNull().default('0'),
    discountTaken: money('discount_taken').notNull().default('0'),
    /** Cash to pay on this bill (open - discount taken, or a partial amount). */
    amount: money('amount').notNull(),
    dueDate: date('due_date').notNull(),
    discountDate: date('discount_date'),
    /** Vendor payment created by execution. */
    paymentId: uuid('payment_id').references(() => vendorPayments.id, { onDelete: 'set null' }),
    failureReason: text('failure_reason'),
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payment_run_lines_run_bill_uq').on(t.runId, t.billId),
    index('payment_run_lines_run_idx').on(t.runId, t.status),
    index('payment_run_lines_bill_idx').on(t.billId),
    check('payment_run_lines_amount_chk', sql`${t.amount} >= 0 AND ${t.discountTaken} >= 0`),
  ],
);

// -------------------------------------------------------------------- accruals

/**
 * Period-end AP accrual (Dr expense / Cr accrued expense) for goods and
 * services received but not billed; auto-reversed on the reversal date.
 */
export const apAccruals = pgTable(
  'ap_accruals',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    status: apAccrualStatusEnum('status').notNull().default('DRAFT'),
    source: apAccrualSourceEnum('source').notNull(),
    accrualDate: date('accrual_date').notNull(),
    reversalDate: date('reversal_date').notNull(),
    description: text('description'),
    totalAmount: money('total_amount').notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => users.id, { onDelete: 'set null' }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ap_accruals_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('ap_accruals_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('ap_accruals_company_date_idx').on(t.companyId, t.accrualDate),
    check('ap_accruals_dates_chk', sql`${t.reversalDate} > ${t.accrualDate}`),
  ],
);

export const apAccrualLines = pgTable(
  'ap_accrual_lines',
  {
    id: primaryId(),
    accrualId: uuid('accrual_id')
      .notNull()
      .references(() => apAccruals.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    orderLineId: uuid('order_line_id').references(() => orderLines.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amount: money('amount').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
  },
  (t) => [
    index('ap_accrual_lines_accrual_idx').on(t.accrualId),
    check('ap_accrual_lines_amount_chk', sql`${t.amount} > 0`),
  ],
);

export type VendorGroup = typeof vendorGroups.$inferSelect;
export type ApSettingsRow = typeof apSettings.$inferSelect;
export type VendorContact = typeof vendorContacts.$inferSelect;
export type VendorAddress = typeof vendorAddresses.$inferSelect;
export type VendorBankAccount = typeof vendorBankAccounts.$inferSelect;
export type VendorProfile = typeof vendorProfiles.$inferSelect;
export type BillHold = typeof billHolds.$inferSelect;
export type PaymentRun = typeof paymentRuns.$inferSelect;
export type PaymentRunLine = typeof paymentRunLines.$inferSelect;
export type ApAccrual = typeof apAccruals.$inferSelect;
export type ApAccrualLine = typeof apAccrualLines.$inferSelect;
