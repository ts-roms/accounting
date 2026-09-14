import { relations, sql } from 'drizzle-orm';
import {
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
  ACCOUNTING_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PAYMENT_TYPES,
  SUBLEDGER_DOCUMENT_STATUSES,
  MATCH_STATUSES,
  SUBLEDGER_DOCUMENT_TYPES,
  type MatchException,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { rate } from './enterprise';
import { products, warehouses } from './inventory';
import { dimensionColumns } from './dimensions';
import { orderLines, orders } from './orders';
import { taxCodes } from './tax';
import { branches, companies } from './organizations';
import { users } from './users';

export const subledgerDocumentTypeEnum = pgEnum(
  'subledger_document_type',
  SUBLEDGER_DOCUMENT_TYPES,
);
export const subledgerDocumentStatusEnum = pgEnum(
  'subledger_document_status',
  SUBLEDGER_DOCUMENT_STATUSES,
);
export const accountingStatusEnum = pgEnum('accounting_status', ACCOUNTING_STATUSES);
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);
export const paymentTypeEnum = pgEnum('payment_type', PAYMENT_TYPES);
export const paymentMethodEnum = pgEnum('payment_method', PAYMENT_METHODS);
export const matchStatusEnum = pgEnum('match_status', MATCH_STATUSES);

/** Columns shared by customers and vendors. */
const partyColumns = () => ({
  id: primaryId(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  taxIdentificationNumber: text('tax_identification_number'),
  email: text('email'),
  phone: text('phone'),
  contactPerson: text('contact_person'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  province: text('province'),
  postalCode: text('postal_code'),
  country: char('country', { length: 2 }).notNull().default('PH'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(30),
  /** Currency the party is invoiced / billed in (Phase 8); documents inherit it. */
  currency: char('currency', { length: 3 }).notNull().default('PHP'),
  notes: text('notes'),
  status: entityStatusEnum('status').notNull().default('ACTIVE'),
  ...timestamps,
});

export const customers = pgTable(
  'customers',
  {
    ...partyColumns(),
    creditLimit: money('credit_limit'),
    defaultRevenueAccountId: uuid('default_revenue_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('customers_company_code_uq').on(t.companyId, t.code),
    index('customers_company_name_idx').on(t.companyId, t.name),
  ],
);

export const vendors = pgTable(
  'vendors',
  {
    ...partyColumns(),
    defaultExpenseAccountId: uuid('default_expense_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('vendors_company_code_uq').on(t.companyId, t.code),
    index('vendors_company_name_idx').on(t.companyId, t.name),
  ],
);

/** Columns shared by customer invoices and vendor bills. */
const documentColumns = () => ({
  id: primaryId(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
  documentType: subledgerDocumentTypeEnum('document_type').notNull().default('INVOICE'),
  documentNumber: text('document_number').notNull(),
  status: subledgerDocumentStatusEnum('status').notNull().default('DRAFT'),
  accountingStatus: accountingStatusEnum('accounting_status').notNull().default('UNPOSTED'),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
    onDelete: 'restrict',
  }),
  reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
    onDelete: 'restrict',
  }),
  documentDate: date('document_date').notNull(),
  dueDate: date('due_date').notNull(),
  reference: text('reference'),
  description: text('description'),
  currency: char('currency', { length: 3 }).notNull(),
  /** Document currency -> company base currency, fixed when the document is created (Phase 8). */
  exchangeRate: rate('exchange_rate').notNull().default('1'),
  /** total x exchangeRate: what the control account carries for this document. */
  baseTotal: money('base_total').notNull().default('0'),
  subtotal: money('subtotal').notNull().default('0'),
  /** Sales tax added by the tax engine (Phase 7). */
  taxTotal: money('tax_total').notNull().default('0'),
  /** Withholding deducted from what the counterparty settles; total = subtotal + tax - withholding. */
  withholdingTotal: money('withholding_total').notNull().default('0'),
  total: money('total').notNull().default('0'),
  /** Amount settled by payments / credit notes. Subledger field, reconciled to the GL. */
  allocatedAmount: money('allocated_amount').notNull().default('0'),
  idempotencyKey: text('idempotency_key'),
  voidReason: text('void_reason'),
  voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

const documentChecks = (
  t: Record<
    | 'total'
    | 'allocatedAmount'
    | 'subtotal'
    | 'taxTotal'
    | 'withholdingTotal'
    | 'dueDate'
    | 'documentDate',
    AnyPgColumn
  >,
  prefix: string,
) => [
  check(
    `${prefix}_total_chk`,
    sql`${t.total} >= 0 AND ${t.total} = ${t.subtotal} + ${t.taxTotal} - ${t.withholdingTotal}`,
  ),
  check(
    `${prefix}_allocated_chk`,
    sql`${t.allocatedAmount} >= 0 AND ${t.allocatedAmount} <= ${t.total}`,
  ),
  check(`${prefix}_due_chk`, sql`${t.dueDate} >= ${t.documentDate}`),
];

export const invoices = pgTable(
  'invoices',
  {
    ...documentColumns(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** Collection tracking */
    promisedPaymentDate: date('promised_payment_date'),
    collectionNotes: text('collection_notes'),
    /** Sales order this invoice fulfils (Phase 4). */
    salesOrderId: uuid('sales_order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    uniqueIndex('invoices_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('invoices_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('invoices_customer_idx').on(t.customerId),
    index('invoices_company_status_idx').on(t.companyId, t.status),
    index('invoices_company_due_idx').on(t.companyId, t.dueDate),
    ...documentChecks(t, 'invoices'),
  ],
);

export const vendorBills = pgTable(
  'vendor_bills',
  {
    ...documentColumns(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    vendorInvoiceNumber: text('vendor_invoice_number'),
    scheduledPaymentDate: date('scheduled_payment_date'),
    /** Purchase order this bill fulfils (Phase 4) and the three-way match result. */
    purchaseOrderId: uuid('purchase_order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'restrict',
    }),
    matchStatus: matchStatusEnum('match_status').notNull().default('NOT_REQUIRED'),
    matchExceptions: jsonb('match_exceptions').$type<MatchException[]>().notNull().default([]),
    matchReviewedBy: uuid('match_reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    matchReviewedAt: timestamp('match_reviewed_at', { withTimezone: true }),
    matchReviewNote: text('match_review_note'),
  },
  (t) => [
    uniqueIndex('vendor_bills_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('vendor_bills_idempotency_uq').on(t.companyId, t.idempotencyKey),
    // Duplicate supplier invoice detection: one supplier number per vendor.
    uniqueIndex('vendor_bills_vendor_invoice_uq').on(t.vendorId, t.vendorInvoiceNumber),
    index('vendor_bills_vendor_idx').on(t.vendorId),
    index('vendor_bills_company_status_idx').on(t.companyId, t.status),
    index('vendor_bills_company_due_idx').on(t.companyId, t.dueDate),
    ...documentChecks(t, 'vendor_bills'),
  ],
);

const lineColumns = () => ({
  id: primaryId(),
  lineNumber: integer('line_number').notNull(),
  description: text('description').notNull(),
  quantity: money('quantity').notNull().default('1'),
  unitPrice: money('unit_price').notNull(),
  discountPercent: money('discount_percent').notNull().default('0'),
  amount: money('amount').notNull(),
  /** Order line fulfilled by this line (Phase 4). */
  orderLineId: uuid('order_line_id').references((): AnyPgColumn => orderLines.id, {
    onDelete: 'restrict',
  }),
  /** Stock moved by this line (Phase 5). */
  productId: uuid('product_id').references((): AnyPgColumn => products.id, {
    onDelete: 'restrict',
  }),
  warehouseId: uuid('warehouse_id').references((): AnyPgColumn => warehouses.id, {
    onDelete: 'restrict',
  }),
  lotNumber: text('lot_number'),
  serialNumbers: jsonb('serial_numbers').$type<string[]>().notNull().default([]),
  /** Cost of goods relieved / received by this line when the document posted. */
  costAmount: money('cost_amount'),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'restrict' }),
  branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
  /** Cost-accounting dimensions and tax (Phase 7). */
  ...dimensionColumns(),
  taxCodeId: uuid('tax_code_id').references((): AnyPgColumn => taxCodes.id, {
    onDelete: 'restrict',
  }),
  taxRate: money('tax_rate').notNull().default('0'),
  taxAmount: money('tax_amount').notNull().default('0'),
  withholdingTaxCodeId: uuid('withholding_tax_code_id').references(
    (): AnyPgColumn => taxCodes.id,
    { onDelete: 'restrict' },
  ),
  withholdingRate: money('withholding_rate').notNull().default('0'),
  withholdingAmount: money('withholding_amount').notNull().default('0'),
});

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    ...lineColumns(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('invoice_lines_number_uq').on(t.invoiceId, t.lineNumber),
    check(
      'invoice_lines_amount_chk',
      sql`${t.amount} >= 0 AND ${t.quantity} > 0 AND ${t.discountPercent} BETWEEN 0 AND 100`,
    ),
    index('invoice_lines_order_line_idx').on(t.orderLineId),
  ],
);

export const billLines = pgTable(
  'bill_lines',
  {
    ...lineColumns(),
    billId: uuid('bill_id')
      .notNull()
      .references(() => vendorBills.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('bill_lines_number_uq').on(t.billId, t.lineNumber),
    check(
      'bill_lines_amount_chk',
      sql`${t.amount} >= 0 AND ${t.quantity} > 0 AND ${t.discountPercent} BETWEEN 0 AND 100`,
    ),
    index('bill_lines_order_line_idx').on(t.orderLineId),
  ],
);

const paymentColumns = () => ({
  id: primaryId(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
  documentNumber: text('document_number').notNull(),
  paymentType: paymentTypeEnum('payment_type').notNull().default('PAYMENT'),
  status: paymentStatusEnum('status').notNull().default('DRAFT'),
  paymentDate: date('payment_date').notNull(),
  amount: money('amount').notNull(),
  /** Payment currency -> base (Phase 8). */
  exchangeRate: rate('exchange_rate').notNull().default('1'),
  /** amount x exchangeRate: the bank-side base amount. */
  baseAmount: money('base_amount').notNull().default('0'),
  /** Base amount relieved from the control account (allocations at document rates, remainder at the payment rate). */
  controlBaseAmount: money('control_base_amount').notNull().default('0'),
  allocatedAmount: money('allocated_amount').notNull().default('0'),
  method: paymentMethodEnum('method').notNull().default('BANK_TRANSFER'),
  cashAccountId: uuid('cash_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'restrict' }),
  reference: text('reference'),
  memo: text('memo'),
  currency: char('currency', { length: 3 }).notNull(),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
    onDelete: 'restrict',
  }),
  reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
    onDelete: 'restrict',
  }),
  idempotencyKey: text('idempotency_key'),
  voidReason: text('void_reason'),
  voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

export const customerPayments = pgTable(
  'customer_payments',
  {
    ...paymentColumns(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('customer_payments_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('customer_payments_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('customer_payments_customer_idx').on(t.customerId),
    check(
      'customer_payments_amount_chk',
      sql`${t.amount} > 0 AND ${t.allocatedAmount} >= 0 AND ${t.allocatedAmount} <= ${t.amount}`,
    ),
  ],
);

export const vendorPayments = pgTable(
  'vendor_payments',
  {
    ...paymentColumns(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('vendor_payments_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('vendor_payments_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('vendor_payments_vendor_idx').on(t.vendorId),
    check(
      'vendor_payments_amount_chk',
      sql`${t.amount} > 0 AND ${t.allocatedAmount} >= 0 AND ${t.allocatedAmount} <= ${t.amount}`,
    ),
  ],
);

/**
 * Settlement of an open document by a payment OR a credit note (exactly one
 * source). Amounts are always positive; the target must be an INVOICE or
 * DEBIT_NOTE of the same party.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id').references(() => customerPayments.id, { onDelete: 'restrict' }),
    creditNoteId: uuid('credit_note_id').references(() => invoices.id, { onDelete: 'restrict' }),
    amount: money('amount').notNull(),
    allocationDate: date('allocation_date').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_allocations_invoice_idx').on(t.invoiceId),
    index('payment_allocations_payment_idx').on(t.paymentId),
    check('payment_allocations_amount_chk', sql`${t.amount} > 0`),
    check(
      'payment_allocations_source_chk',
      sql`(${t.paymentId} IS NOT NULL)::int + (${t.creditNoteId} IS NOT NULL)::int = 1`,
    ),
  ],
);

export const vendorPaymentAllocations = pgTable(
  'vendor_payment_allocations',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    billId: uuid('bill_id')
      .notNull()
      .references(() => vendorBills.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id').references(() => vendorPayments.id, { onDelete: 'restrict' }),
    creditNoteId: uuid('credit_note_id').references(() => vendorBills.id, { onDelete: 'restrict' }),
    amount: money('amount').notNull(),
    allocationDate: date('allocation_date').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vendor_payment_allocations_bill_idx').on(t.billId),
    index('vendor_payment_allocations_payment_idx').on(t.paymentId),
    check('vendor_payment_allocations_amount_chk', sql`${t.amount} > 0`),
    check(
      'vendor_payment_allocations_source_chk',
      sql`(${t.paymentId} IS NOT NULL)::int + (${t.creditNoteId} IS NOT NULL)::int = 1`,
    ),
  ],
);

export const customersRelations = relations(customers, ({ many }) => ({
  invoices: many(invoices),
  payments: many(customerPayments),
}));
export const vendorsRelations = relations(vendors, ({ many }) => ({
  bills: many(vendorBills),
  payments: many(vendorPayments),
}));
export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  lines: many(invoiceLines),
}));
export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
}));
export const vendorBillsRelations = relations(vendorBills, ({ one, many }) => ({
  vendor: one(vendors, { fields: [vendorBills.vendorId], references: [vendors.id] }),
  lines: many(billLines),
}));
export const billLinesRelations = relations(billLines, ({ one }) => ({
  bill: one(vendorBills, { fields: [billLines.billId], references: [vendorBills.id] }),
}));

export type Customer = typeof customers.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type VendorBill = typeof vendorBills.$inferSelect;
export type BillLine = typeof billLines.$inferSelect;
export type CustomerPayment = typeof customerPayments.$inferSelect;
export type VendorPayment = typeof vendorPayments.$inferSelect;
export type PaymentAllocation = typeof paymentAllocations.$inferSelect;
export type VendorPaymentAllocation = typeof vendorPaymentAllocations.$inferSelect;
