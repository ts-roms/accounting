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
  COLLECTION_ACTIVITY_TYPES,
  COLLECTION_CASE_STATUSES,
  CREDIT_RISK_RATINGS,
  CREDIT_RULE_ACTIONS,
  CREDIT_RULE_SCOPES,
  CREDIT_RULE_TRIGGERS,
  CUSTOMER_ADDRESS_TYPES,
  DEFAULT_AGING_BUCKETS,
  DELIVERY_STATUSES,
  DISPUTE_REASONS,
  DISPUTE_RESOLUTIONS,
  DISPUTE_STATUSES,
  DUNNING_ACTIONS,
  PAYMENT_METHODS,
  PAYMENT_TERM_BASES,
  PROMISE_STATUSES,
  PROVISION_METHODS,
  PROVISION_STATUSES,
  REFUND_REQUEST_STATUSES,
  WRITE_OFF_REASONS,
  WRITE_OFF_STATUSES,
  type AgingBucketDefinition,
  type DunningStep,
  type ProvisionRates,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { rate } from './enterprise';
import { products, warehouses } from './inventory';
import { orderLines, orders } from './orders';
import { branches, companies } from './organizations';
import { customerPayments, customers, invoices } from './subledger';
import { taxCodes } from './tax';
import { users } from './users';

/** Declared here (not in subledger.ts) because this module is evaluated first in the import cycle. */
export const paymentMethodEnum = pgEnum('payment_method', PAYMENT_METHODS);
export const customerAddressTypeEnum = pgEnum('customer_address_type', CUSTOMER_ADDRESS_TYPES);
export const paymentTermBasisEnum = pgEnum('payment_term_basis', PAYMENT_TERM_BASES);
export const creditRiskRatingEnum = pgEnum('credit_risk_rating', CREDIT_RISK_RATINGS);
export const creditRuleTriggerEnum = pgEnum('credit_rule_trigger', CREDIT_RULE_TRIGGERS);
export const creditRuleActionEnum = pgEnum('credit_rule_action', CREDIT_RULE_ACTIONS);
export const creditRuleScopeEnum = pgEnum('credit_rule_scope', CREDIT_RULE_SCOPES);
export const deliveryStatusEnum = pgEnum('delivery_status', DELIVERY_STATUSES);
export const collectionCaseStatusEnum = pgEnum('collection_case_status', COLLECTION_CASE_STATUSES);
export const collectionActivityTypeEnum = pgEnum(
  'collection_activity_type',
  COLLECTION_ACTIVITY_TYPES,
);
export const promiseStatusEnum = pgEnum('promise_status', PROMISE_STATUSES);
export const dunningActionEnum = pgEnum('dunning_action', DUNNING_ACTIONS);
export const disputeReasonEnum = pgEnum('dispute_reason', DISPUTE_REASONS);
export const disputeStatusEnum = pgEnum('dispute_status', DISPUTE_STATUSES);
export const disputeResolutionEnum = pgEnum('dispute_resolution', DISPUTE_RESOLUTIONS);
export const writeOffReasonEnum = pgEnum('write_off_reason', WRITE_OFF_REASONS);
export const writeOffStatusEnum = pgEnum('write_off_status', WRITE_OFF_STATUSES);
export const provisionMethodEnum = pgEnum('provision_method', PROVISION_METHODS);
export const provisionStatusEnum = pgEnum('provision_status', PROVISION_STATUSES);
export const refundRequestStatusEnum = pgEnum('refund_request_status', REFUND_REQUEST_STATUSES);

// ------------------------------------------------------------ configuration

/** Named payment terms (NET 30, COD, EOM+15...). Due dates are computed from the basis; nothing is hard-coded. */
export const paymentTerms = pgTable(
  'payment_terms',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    basis: paymentTermBasisEnum('basis').notNull().default('NET_DAYS'),
    days: integer('days').notNull().default(30),
    dayOfMonth: integer('day_of_month'),
    discountPercent: money('discount_percent').notNull().default('0'),
    discountDays: integer('discount_days').notNull().default(0),
    description: text('description'),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('payment_terms_company_code_uq').on(t.companyId, t.code)],
);

/** Dunning policy: ordered steps by days overdue. Nothing runs without a policy. */
export const dunningPolicies = pgTable(
  'dunning_policies',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    steps: jsonb('steps').$type<DunningStep[]>().notNull().default([]),
    minimumAmount: money('minimum_amount').notNull().default('0'),
    isDefault: boolean('is_default').notNull().default(false),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [index('dunning_policies_company_idx').on(t.companyId, t.status)],
);

/** Customer groups carry pricing, credit, terms, tax and collection defaults. */
export const customerGroups = pgTable(
  'customer_groups',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    paymentTermId: uuid('payment_term_id').references(() => paymentTerms.id, {
      onDelete: 'set null',
    }),
    defaultCreditLimit: money('default_credit_limit'),
    taxCodeId: uuid('tax_code_id').references((): AnyPgColumn => taxCodes.id, {
      onDelete: 'set null',
    }),
    priceDiscountPercent: money('price_discount_percent').notNull().default('0'),
    dunningPolicyId: uuid('dunning_policy_id').references(() => dunningPolicies.id, {
      onDelete: 'set null',
    }),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('customer_groups_company_code_uq').on(t.companyId, t.code)],
);

/** Configurable credit policies: what to check and what to do when it fires. */
export const creditRules = pgTable(
  'credit_rules',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    scope: creditRuleScopeEnum('scope').notNull(),
    trigger: creditRuleTriggerEnum('trigger').notNull(),
    action: creditRuleActionEnum('action').notNull(),
    thresholdAmount: money('threshold_amount'),
    thresholdPercent: money('threshold_percent'),
    thresholdDays: integer('threshold_days'),
    customerGroupId: uuid('customer_group_id').references(() => customerGroups.id, {
      onDelete: 'cascade',
    }),
    priority: integer('priority').notNull().default(100),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [index('credit_rules_company_scope_idx').on(t.companyId, t.scope, t.status)],
);

/** Per-company AR policy: aging buckets, DSO window, thresholds, approval requirements. */
export const arSettings = pgTable('ar_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  agingBuckets: jsonb('aging_buckets')
    .$type<AgingBucketDefinition[]>()
    .notNull()
    .default([...DEFAULT_AGING_BUCKETS]),
  dsoWindowDays: integer('dso_window_days').notNull().default(90),
  unappliedCashWarnDays: integer('unapplied_cash_warn_days').notNull().default(30),
  smallBalanceThreshold: money('small_balance_threshold').notNull().default('0'),
  autoCaseDaysOverdue: integer('auto_case_days_overdue').notNull().default(0),
  requirePaymentApproval: boolean('require_payment_approval').notNull().default(false),
  useAllowanceForBadDebt: boolean('use_allowance_for_bad_debt').notNull().default(true),
  provisionRates: jsonb('provision_rates').$type<ProvisionRates>().notNull().default({}),
  creditCheckOnSalesOrder: boolean('credit_check_on_sales_order').notNull().default(true),
  creditCheckOnInvoice: boolean('credit_check_on_invoice').notNull().default(true),
  defaultDunningPolicyId: uuid('default_dunning_policy_id').references(() => dunningPolicies.id, {
    onDelete: 'set null',
  }),
  defaultPaymentTermId: uuid('default_payment_term_id').references(() => paymentTerms.id, {
    onDelete: 'set null',
  }),
  ...timestamps,
});

// ------------------------------------------------------------ customer master

export const customerContacts = pgTable(
  'customer_contacts',
  {
    id: primaryId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title'),
    role: text('role'),
    email: text('email'),
    phone: text('phone'),
    isPrimary: boolean('is_primary').notNull().default(false),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [index('customer_contacts_customer_idx').on(t.customerId)],
);

export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: primaryId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    addressType: customerAddressTypeEnum('address_type').notNull(),
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
  (t) => [index('customer_addresses_customer_idx').on(t.customerId, t.addressType)],
);

/**
 * Credit control state per customer. The limit itself lives on `customers`
 * (one source); this row carries the hold, the risk rating and the review
 * trail. Credit used / available are always derived from the subledger.
 */
export const customerCreditProfiles = pgTable('customer_credit_profiles', {
  customerId: uuid('customer_id')
    .primaryKey()
    .references(() => customers.id, { onDelete: 'cascade' }),
  creditHold: boolean('credit_hold').notNull().default(false),
  creditHoldReason: text('credit_hold_reason'),
  creditHoldAt: timestamp('credit_hold_at', { withTimezone: true }),
  creditHoldBy: uuid('credit_hold_by').references(() => users.id, { onDelete: 'set null' }),
  /** Set when the hold was applied by a dunning policy rather than a person. */
  creditHoldSource: text('credit_hold_source'),
  riskRating: creditRiskRatingEnum('risk_rating').notNull().default('LOW'),
  reviewDate: date('review_date'),
  reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  notes: text('notes'),
  ...timestamps,
});

// ----------------------------------------------------------------- deliveries

/**
 * Delivery against a sales order. Stock leaves through InventoryService when
 * the delivery is DELIVERED (Dr COGS / Cr inventory in one posting), and the
 * invoice that follows does not move stock again.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id').references((): AnyPgColumn => warehouses.id, {
      onDelete: 'restrict',
    }),
    shippingAddressId: uuid('shipping_address_id').references(() => customerAddresses.id, {
      onDelete: 'set null',
    }),
    status: deliveryStatusEnum('status').notNull().default('DRAFT'),
    deliveryDate: date('delivery_date').notNull(),
    reference: text('reference'),
    notes: text('notes'),
    cancelReason: text('cancel_reason'),
    /** COGS entry posted when goods left (stocked lines only) and its reversal on cancel. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    deliveredBy: uuid('delivered_by').references(() => users.id, { onDelete: 'set null' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('deliveries_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('deliveries_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('deliveries_order_idx').on(t.salesOrderId),
    index('deliveries_customer_idx').on(t.customerId),
    index('deliveries_company_status_idx').on(t.companyId, t.status),
  ],
);

export const deliveryLines = pgTable(
  'delivery_lines',
  {
    id: primaryId(),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'restrict' }),
    productId: uuid('product_id').references((): AnyPgColumn => products.id, {
      onDelete: 'restrict',
    }),
    warehouseId: uuid('warehouse_id').references((): AnyPgColumn => warehouses.id, {
      onDelete: 'restrict',
    }),
    description: text('description').notNull(),
    quantity: money('quantity').notNull(),
    lotNumber: text('lot_number'),
    serialNumbers: jsonb('serial_numbers').$type<string[]>().notNull().default([]),
    /** Cost relieved from stock when delivered. */
    costAmount: money('cost_amount'),
    /** Quantity already invoiced from this delivery line. */
    invoicedQuantity: money('invoiced_quantity').notNull().default('0'),
  },
  (t) => [
    uniqueIndex('delivery_lines_number_uq').on(t.deliveryId, t.lineNumber),
    index('delivery_lines_order_line_idx').on(t.orderLineId),
    check('delivery_lines_qty_chk', sql`${t.quantity} > 0 AND ${t.invoicedQuantity} >= 0`),
  ],
);

// -------------------------------------------------------------------- refunds

/**
 * A refund request turns customer credit (overpayment / unapplied cash /
 * credit note balance) into money out. Approval is workflow + delegated
 * authority gated; paying it creates and posts a REFUND customer payment.
 */
export const paymentRefunds = pgTable(
  'payment_refunds',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id').references(() => customerPayments.id, {
      onDelete: 'set null',
    }),
    creditNoteId: uuid('credit_note_id').references(() => invoices.id, { onDelete: 'set null' }),
    status: refundRequestStatusEnum('status').notNull().default('DRAFT'),
    currency: char('currency', { length: 3 }).notNull(),
    amount: money('amount').notNull(),
    reason: text('reason').notNull(),
    method: paymentMethodEnum('method').notNull().default('BANK_TRANSFER'),
    cashAccountId: uuid('cash_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    reference: text('reference'),
    /** The REFUND payment that settled this request. */
    refundPaymentId: uuid('refund_payment_id').references(() => customerPayments.id, {
      onDelete: 'restrict',
    }),
    decisionComment: text('decision_comment'),
    idempotencyKey: text('idempotency_key'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    paidBy: uuid('paid_by').references(() => users.id, { onDelete: 'set null' }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payment_refunds_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('payment_refunds_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('payment_refunds_customer_idx').on(t.customerId),
    index('payment_refunds_company_status_idx').on(t.companyId, t.status),
    check('payment_refunds_amount_chk', sql`${t.amount} > 0`),
  ],
);

// ---------------------------------------------------------------- collections

export const collectionCases = pgTable(
  'collection_cases',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    status: collectionCaseStatusEnum('status').notNull().default('NEW'),
    collectorId: uuid('collector_id').references(() => users.id, { onDelete: 'set null' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lastContactAt: timestamp('last_contact_at', { withTimezone: true }),
    nextActionAt: date('next_action_at'),
    nextAction: text('next_action'),
    /** How the case was opened: MANUAL, AUTO (aging policy) or DUNNING. */
    source: text('source').notNull().default('MANUAL'),
    escalationLevel: integer('escalation_level').notNull().default(0),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('collection_cases_company_number_uq').on(t.companyId, t.documentNumber),
    index('collection_cases_customer_idx').on(t.customerId, t.status),
    index('collection_cases_company_status_idx').on(t.companyId, t.status),
    index('collection_cases_collector_idx').on(t.collectorId),
  ],
);

export const collectionActivities = pgTable(
  'collection_activities',
  {
    id: primaryId(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => collectionCases.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    activityType: collectionActivityTypeEnum('activity_type').notNull(),
    summary: text('summary').notNull(),
    details: text('details'),
    contactName: text('contact_name'),
    /** Dunning steps record the policy step that produced them. */
    dunningPolicyId: uuid('dunning_policy_id').references(() => dunningPolicies.id, {
      onDelete: 'set null',
    }),
    dunningStep: integer('dunning_step'),
    performedBy: uuid('performed_by').references(() => users.id, { onDelete: 'set null' }),
    performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collection_activities_case_idx').on(t.caseId, t.performedAt),
    index('collection_activities_customer_idx').on(t.customerId),
    // One dunning step per invoice per policy - the job is idempotent.
    uniqueIndex('collection_activities_dunning_uq').on(
      t.invoiceId,
      t.dunningPolicyId,
      t.dunningStep,
    ),
  ],
);

export const promisesToPay = pgTable(
  'promises_to_pay',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    caseId: uuid('case_id').references(() => collectionCases.id, { onDelete: 'set null' }),
    status: promiseStatusEnum('status').notNull().default('PENDING'),
    currency: char('currency', { length: 3 }).notNull(),
    amount: money('amount').notNull(),
    promiseDate: date('promise_date').notNull(),
    invoiceIds: jsonb('invoice_ids').$type<string[]>().notNull().default([]),
    collectorId: uuid('collector_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    /** Receipts posted between the promise and its date, evaluated by the job. */
    settledAmount: money('settled_amount').notNull().default('0'),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('promises_customer_idx').on(t.customerId, t.status),
    index('promises_company_status_idx').on(t.companyId, t.status, t.promiseDate),
    check('promises_amount_chk', sql`${t.amount} > 0`),
  ],
);

// ------------------------------------------------------------------- disputes

export const invoiceDisputes = pgTable(
  'invoice_disputes',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    caseId: uuid('case_id').references(() => collectionCases.id, { onDelete: 'set null' }),
    status: disputeStatusEnum('status').notNull().default('OPEN'),
    reason: disputeReasonEnum('reason').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amount: money('amount').notNull(),
    description: text('description').notNull(),
    raisedBy: text('raised_by'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    resolution: disputeResolutionEnum('resolution'),
    resolutionNotes: text('resolution_notes'),
    creditNoteId: uuid('credit_note_id').references(() => invoices.id, { onDelete: 'set null' }),
    openedBy: uuid('opened_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('invoice_disputes_company_number_uq').on(t.companyId, t.documentNumber),
    index('invoice_disputes_invoice_idx').on(t.invoiceId, t.status),
    index('invoice_disputes_customer_idx').on(t.customerId),
    check('invoice_disputes_amount_chk', sql`${t.amount} >= 0`),
  ],
);

// ----------------------------------------------------------------- write-offs

/**
 * Controlled removal of a receivable balance. Nothing leaves the subledger
 * without a permission, an approval, a reason and a journal: posting credits
 * the AR control through AccountingPostingService and settles the invoice
 * through a write-off allocation (so aging, statements and the AR/GL
 * reconciliation all agree).
 */
export const writeOffRequests = pgTable(
  'write_off_requests',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    status: writeOffStatusEnum('status').notNull().default('DRAFT'),
    reason: writeOffReasonEnum('reason').notNull(),
    justification: text('justification').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amount: money('amount').notNull(),
    /** Document rate -> base; the ledger effect is `amount x exchangeRate`. */
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    baseAmount: money('base_amount').notNull().default('0'),
    writeOffDate: date('write_off_date'),
    /** Expense / allowance account debited (resolved from mappings at posting time, recorded for the trail). */
    debitAccountId: uuid('debit_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    recoveryJournalEntryId: uuid('recovery_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    recoveryDate: date('recovery_date'),
    recoveryReason: text('recovery_reason'),
    decisionComment: text('decision_comment'),
    idempotencyKey: text('idempotency_key'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('write_off_requests_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('write_off_requests_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('write_off_requests_invoice_idx').on(t.invoiceId),
    index('write_off_requests_customer_idx').on(t.customerId),
    index('write_off_requests_company_status_idx').on(t.companyId, t.status),
    check('write_off_requests_amount_chk', sql`${t.amount} > 0`),
  ],
);

/** Bad-debt allowance run: brings the allowance account to the computed provision. */
export const badDebtProvisions = pgTable(
  'bad_debt_provisions',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    status: provisionStatusEnum('status').notNull().default('DRAFT'),
    asOf: date('as_of').notNull(),
    method: provisionMethodEnum('method').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Snapshot of the computation (bucket balances, rates, per-invoice amounts). */
    computation: jsonb('computation').$type<Record<string, unknown>>().notNull().default({}),
    requiredAllowance: money('required_allowance').notNull(),
    existingAllowance: money('existing_allowance').notNull(),
    /** requiredAllowance - existingAllowance: positive = expense, negative = release. */
    adjustment: money('adjustment').notNull(),
    description: text('description'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('bad_debt_provisions_company_number_uq').on(t.companyId, t.documentNumber),
    index('bad_debt_provisions_company_idx').on(t.companyId, t.asOf),
  ],
);

// ----------------------------------------------------------------- statements

/** Generated statement snapshots (what was sent to the customer), never a balance source. */
export const customerStatements = pgTable(
  'customer_statements',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    openingBalance: money('opening_balance').notNull(),
    closingBalance: money('closing_balance').notNull(),
    lines: jsonb('lines').$type<Record<string, unknown>[]>().notNull().default([]),
    generatedBy: uuid('generated_by').references(() => users.id, { onDelete: 'set null' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_statements_company_number_uq').on(t.companyId, t.documentNumber),
    index('customer_statements_customer_idx').on(t.customerId, t.toDate),
  ],
);

export type PaymentTerm = typeof paymentTerms.$inferSelect;
export type CustomerGroup = typeof customerGroups.$inferSelect;
export type CreditRule = typeof creditRules.$inferSelect;
export type ArSettings = typeof arSettings.$inferSelect;
export type CustomerContact = typeof customerContacts.$inferSelect;
export type CustomerAddress = typeof customerAddresses.$inferSelect;
export type CustomerCreditProfile = typeof customerCreditProfiles.$inferSelect;
export type Delivery = typeof deliveries.$inferSelect;
export type DeliveryLine = typeof deliveryLines.$inferSelect;
export type PaymentRefund = typeof paymentRefunds.$inferSelect;
export type CollectionCase = typeof collectionCases.$inferSelect;
export type CollectionActivity = typeof collectionActivities.$inferSelect;
export type PromiseToPay = typeof promisesToPay.$inferSelect;
export type InvoiceDispute = typeof invoiceDisputes.$inferSelect;
export type WriteOffRequest = typeof writeOffRequests.$inferSelect;
export type BadDebtProvision = typeof badDebtProvisions.$inferSelect;
export type CustomerStatement = typeof customerStatements.$inferSelect;
export type DunningPolicy = typeof dunningPolicies.$inferSelect;
