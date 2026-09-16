import { sql } from 'drizzle-orm';
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  FULFILLMENT_STATUSES,
  GOODS_RECEIPT_STATUSES,
  ORDER_STATUSES,
  ORDER_TYPES,
  RETURN_STATUSES,
  RETURN_TYPES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { products, warehouses } from './inventory';
import { branches, companies } from './organizations';
import { customers, vendors } from './subledger';
import { users } from './users';

export const orderTypeEnum = pgEnum('order_type', ORDER_TYPES);
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);
export const fulfillmentStatusEnum = pgEnum('fulfillment_status', FULFILLMENT_STATUSES);
export const goodsReceiptStatusEnum = pgEnum('goods_receipt_status', GOODS_RECEIPT_STATUSES);
export const returnTypeEnum = pgEnum('return_type', RETURN_TYPES);
export const returnStatusEnum = pgEnum('return_status', RETURN_STATUSES);

/**
 * Quotations, sales orders, purchase requests and purchase orders. None of
 * these touch the ledger: the accounting effect happens when an order is
 * invoiced / billed through the AR / AP subledgers.
 */
export const orders = pgTable(
  'orders',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    orderType: orderTypeEnum('order_type').notNull(),
    documentNumber: text('document_number').notNull(),
    status: orderStatusEnum('status').notNull().default('DRAFT'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    orderDate: date('order_date').notNull(),
    /** Validity (quotation), requested delivery (sales order) or expected receipt (purchase order). */
    expectedDate: date('expected_date'),
    reference: text('reference'),
    description: text('description'),
    notes: text('notes'),
    currency: text('currency').notNull(),
    subtotal: money('subtotal').notNull().default('0'),
    discountTotal: money('discount_total').notNull().default('0'),
    total: money('total').notNull().default('0'),
    /** Receiving progress (purchase orders only). */
    receiptStatus: fulfillmentStatusEnum('receipt_status').notNull().default('NONE'),
    /** Invoicing (sales orders) / billing (purchase orders) progress. */
    billingStatus: fulfillmentStatusEnum('billing_status').notNull().default('NONE'),
    /** Delivery progress (sales orders, Prompt #6). */
    deliveryStatus: fulfillmentStatusEnum('delivery_status').notNull().default('NONE'),
    /** Named payment term, salesperson and shipping warehouse carried to the invoice (Prompt #6). */
    paymentTermId: uuid('payment_term_id'),
    salespersonId: uuid('salesperson_id').references(() => users.id, { onDelete: 'set null' }),
    warehouseId: uuid('warehouse_id').references((): AnyPgColumn => warehouses.id, {
      onDelete: 'restrict',
    }),
    /** Credit check outcome recorded when the order was submitted / approved (Prompt #6). */
    creditCheck: jsonb('credit_check').$type<Record<string, unknown>>(),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Quotation -> sales order, purchase request -> purchase order. */
    sourceOrderId: uuid('source_order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'restrict',
    }),
    convertedOrderId: uuid('converted_order_id').references((): AnyPgColumn => orders.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    rejectionReason: text('rejection_reason'),
    cancelReason: text('cancel_reason'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('orders_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('orders_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('orders_company_type_status_idx').on(t.companyId, t.orderType, t.status),
    index('orders_customer_idx').on(t.customerId),
    index('orders_vendor_idx').on(t.vendorId),
    // Sales documents carry a customer, purchase orders a vendor; requests may have neither yet.
    check(
      'orders_party_chk',
      sql`(${t.orderType} IN ('QUOTATION', 'SALES_ORDER') AND ${t.customerId} IS NOT NULL AND ${t.vendorId} IS NULL)
        OR (${t.orderType} = 'PURCHASE_ORDER' AND ${t.vendorId} IS NOT NULL AND ${t.customerId} IS NULL)
        OR (${t.orderType} = 'PURCHASE_REQUEST' AND ${t.customerId} IS NULL)`,
    ),
    check(
      'orders_totals_chk',
      sql`${t.subtotal} >= 0 AND ${t.discountTotal} >= 0 AND ${t.total} = ${t.subtotal} - ${t.discountTotal}`,
    ),
  ],
);

export const orderLines = pgTable(
  'order_lines',
  {
    id: primaryId(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    description: text('description').notNull(),
    quantity: money('quantity').notNull().default('1'),
    unitPrice: money('unit_price').notNull(),
    discountPercent: money('discount_percent').notNull().default('0'),
    /** quantity * unitPrice * (1 - discount) rounded half-even. */
    amount: money('amount').notNull(),
    /** Revenue (sales) or expense / asset (purchasing) account used when invoicing or billing. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    /** Fulfilment counters, maintained inside the same transaction as the fulfilling document. */
    receivedQuantity: money('received_quantity').notNull().default('0'),
    billedQuantity: money('billed_quantity').notNull().default('0'),
    returnedQuantity: money('returned_quantity').notNull().default('0'),
    /** Quantity shipped through deliveries (sales orders, Prompt #6). */
    deliveredQuantity: money('delivered_quantity').notNull().default('0'),
    /** Unit of measure label carried from the product (informational). */
    unit: text('unit'),
    /** Line of the source quotation / request this line was converted from. */
    sourceLineId: uuid('source_line_id').references((): AnyPgColumn => orderLines.id, {
      onDelete: 'set null',
    }),
    /** Stocked product and the warehouse it ships from / arrives into (Phase 5). */
    productId: uuid('product_id').references((): AnyPgColumn => products.id, {
      onDelete: 'restrict',
    }),
    warehouseId: uuid('warehouse_id').references((): AnyPgColumn => warehouses.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    uniqueIndex('order_lines_number_uq').on(t.orderId, t.lineNumber),
    check(
      'order_lines_qty_chk',
      sql`${t.quantity} > 0 AND ${t.amount} >= 0 AND ${t.discountPercent} >= 0 AND ${t.discountPercent} <= 100`,
    ),
    check(
      'order_lines_fulfilment_chk',
      sql`${t.receivedQuantity} >= 0 AND ${t.billedQuantity} >= 0 AND ${t.returnedQuantity} >= 0 AND ${t.deliveredQuantity} >= 0`,
    ),
  ],
);

/** Receiving against a purchase order. No ledger effect until inventory valuation (Phase 5). */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    status: goodsReceiptStatusEnum('status').notNull().default('DRAFT'),
    receiptDate: date('receipt_date').notNull(),
    reference: text('reference'),
    notes: text('notes'),
    idempotencyKey: text('idempotency_key'),
    cancelReason: text('cancel_reason'),
    /** Receipt accrual (Dr inventory / Cr GRNI) and its reversal on cancel (Phase 5). */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    confirmedBy: uuid('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('goods_receipts_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('goods_receipts_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('goods_receipts_order_idx').on(t.purchaseOrderId),
    index('goods_receipts_company_status_idx').on(t.companyId, t.status),
  ],
);

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: primaryId(),
    goodsReceiptId: uuid('goods_receipt_id')
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'restrict' }),
    quantity: money('quantity').notNull(),
    notes: text('notes'),
    lotNumber: text('lot_number'),
    expiryDate: date('expiry_date'),
    serialNumbers: jsonb('serial_numbers').$type<string[]>().notNull().default([]),
    /** Cost per unit at which stock was received (PO net price). */
    unitCost: money('unit_cost'),
  },
  (t) => [
    uniqueIndex('goods_receipt_lines_number_uq').on(t.goodsReceiptId, t.lineNumber),
    uniqueIndex('goods_receipt_lines_order_line_uq').on(t.goodsReceiptId, t.orderLineId),
    check('goods_receipt_lines_qty_chk', sql`${t.quantity} > 0`),
  ],
);

/** Sales returns (customer sends goods back) and purchase returns (goods sent back to a vendor). */
export const returns = pgTable(
  'returns',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    returnType: returnTypeEnum('return_type').notNull(),
    documentNumber: text('document_number').notNull(),
    status: returnStatusEnum('status').notNull().default('DRAFT'),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    returnDate: date('return_date').notNull(),
    reference: text('reference'),
    reason: text('reason'),
    currency: text('currency').notNull(),
    total: money('total').notNull().default('0'),
    /** Credit note (AR) or vendor credit note (AP) issued for this return. */
    creditNoteId: uuid('credit_note_id'),
    idempotencyKey: text('idempotency_key'),
    cancelReason: text('cancel_reason'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    creditedAt: timestamp('credited_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('returns_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('returns_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('returns_order_idx').on(t.orderId),
    index('returns_company_type_status_idx').on(t.companyId, t.returnType, t.status),
    check(
      'returns_party_chk',
      sql`(${t.returnType} = 'SALES' AND ${t.customerId} IS NOT NULL AND ${t.vendorId} IS NULL)
        OR (${t.returnType} = 'PURCHASE' AND ${t.vendorId} IS NOT NULL AND ${t.customerId} IS NULL)`,
    ),
    check('returns_total_chk', sql`${t.total} >= 0`),
  ],
);

export const returnLines = pgTable(
  'return_lines',
  {
    id: primaryId(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => returns.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantity: money('quantity').notNull(),
    /** Net unit price of the order line (after discount) - what is credited back. */
    unitPrice: money('unit_price').notNull(),
    amount: money('amount').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    productId: uuid('product_id').references((): AnyPgColumn => products.id, {
      onDelete: 'restrict',
    }),
    warehouseId: uuid('warehouse_id').references((): AnyPgColumn => warehouses.id, {
      onDelete: 'restrict',
    }),
    lotNumber: text('lot_number'),
    serialNumbers: jsonb('serial_numbers').$type<string[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex('return_lines_number_uq').on(t.returnId, t.lineNumber),
    uniqueIndex('return_lines_order_line_uq').on(t.returnId, t.orderLineId),
    check('return_lines_qty_chk', sql`${t.quantity} > 0 AND ${t.amount} >= 0`),
  ],
);

/** Per-company matching tolerances and receiving rules - configuration, never hard-coded. */
export const purchasingSettings = pgTable(
  'purchasing_settings',
  {
    companyId: uuid('company_id')
      .primaryKey()
      .references(() => companies.id, { onDelete: 'cascade' }),
    priceTolerancePercent: money('price_tolerance_percent').notNull().default('0'),
    quantityTolerancePercent: money('quantity_tolerance_percent').notNull().default('0'),
    overReceiptTolerancePercent: money('over_receipt_tolerance_percent').notNull().default('0'),
    requirePurchaseOrder: boolean('require_purchase_order').notNull().default(false),
    requireReceiptBeforeBill: boolean('require_receipt_before_bill').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    check(
      'purchasing_settings_pct_chk',
      sql`${t.priceTolerancePercent} BETWEEN 0 AND 100 AND ${t.quantityTolerancePercent} BETWEEN 0 AND 100 AND ${t.overReceiptTolerancePercent} BETWEEN 0 AND 100`,
    ),
  ],
);

export type Order = typeof orders.$inferSelect;
export type OrderLine = typeof orderLines.$inferSelect;
export type GoodsReceipt = typeof goodsReceipts.$inferSelect;
export type GoodsReceiptLine = typeof goodsReceiptLines.$inferSelect;
export type Return = typeof returns.$inferSelect;
export type ReturnLine = typeof returnLines.$inferSelect;
export type PurchasingSettings = typeof purchasingSettings.$inferSelect;
