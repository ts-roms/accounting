import { z } from 'zod';
import {
  GOODS_RECEIPT_STATUSES,
  ORDER_STATUSES,
  RETURN_STATUSES,
  RETURN_TYPES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import { optionalText, paginationQuerySchema, queryBooleanSchema, uuidSchema } from './primitives';
import { percentSchema, quantitySchema } from './subledger';

// -------------------------------------------------------------------- orders

/** A commercial line: description, quantity, unit price, optional discount and the GL account used on invoicing/billing. */
export const orderLineSchema = z.object({
  description: z.string().trim().min(1, 'Description is required').max(300),
  quantity: quantitySchema.default('1'),
  unitPrice: amountSchema,
  discountPercent: percentSchema.default('0'),
  accountId: uuidSchema,
  branchId: uuidSchema.nullable().optional(),
  /** Stocked product (Phase 5). Goods lines need a warehouse to receive into / ship from. */
  productId: uuidSchema.nullable().optional(),
  warehouseId: uuidSchema.nullable().optional(),
});
export type OrderLineInput = z.infer<typeof orderLineSchema>;

const orderBase = z.object({
  orderDate: isoDateSchema,
  /** Quotation validity / requested delivery / expected receipt, depending on the type. */
  expectedDate: isoDateSchema.nullable().optional(),
  reference: optionalText(100),
  description: optionalText(500),
  notes: optionalText(2000),
  branchId: uuidSchema.nullable().optional(),
  lines: z.array(orderLineSchema).min(1, 'At least one line is required').max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

/** Quotations and sales orders belong to a customer. */
export const createSalesDocumentSchema = orderBase.extend({
  customerId: uuidSchema,
  /** Prompt #6: named payment term, salesperson and shipping warehouse carried to deliveries / invoices. */
  paymentTermId: uuidSchema.nullable().optional(),
  salespersonId: uuidSchema.nullable().optional(),
  warehouseId: uuidSchema.nullable().optional(),
});
export type CreateSalesDocumentInput = z.infer<typeof createSalesDocumentSchema>;

/** Purchase requests may not have a vendor yet; purchase orders must. */
export const createPurchaseRequestSchema = orderBase.extend({
  vendorId: uuidSchema.nullable().optional(),
});
export type CreatePurchaseRequestInput = z.infer<typeof createPurchaseRequestSchema>;

export const createPurchaseOrderSchema = orderBase.extend({ vendorId: uuidSchema });
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

/** Superset used by the generic service; the controller applies the type-specific schema first. */
export const createOrderSchema = orderBase.extend({
  customerId: uuidSchema.optional(),
  vendorId: uuidSchema.nullable().optional(),
  paymentTermId: uuidSchema.nullable().optional(),
  salespersonId: uuidSchema.nullable().optional(),
  warehouseId: uuidSchema.nullable().optional(),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export const updateOrderSchema = createOrderSchema.omit({ idempotencyKey: true }).partial();
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export const listOrdersQuerySchema = paginationQuerySchema.extend({
  partyId: uuidSchema.optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** Only orders that can still be invoiced / received / billed. */
  openOnly: queryBooleanSchema.optional(),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const rejectOrderSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type RejectOrderInput = z.infer<typeof rejectOrderSchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

/** Converting a purchase request into a purchase order requires the vendor. */
export const convertOrderSchema = z.object({
  vendorId: uuidSchema.optional(),
  orderDate: isoDateSchema.optional(),
  expectedDate: isoDateSchema.nullable().optional(),
});
export type ConvertOrderInput = z.infer<typeof convertOrderSchema>;

// ---------------------------------------------------------------- fulfilment

/** Quantity of an order line to invoice / receive / bill / return. */
export const fulfilmentLineSchema = z.object({
  orderLineId: uuidSchema,
  quantity: quantitySchema,
  /** Billing only: the vendor's actual price, when it differs from the order. */
  unitPrice: amountSchema.optional(),
});
export type FulfilmentLineInput = z.infer<typeof fulfilmentLineSchema>;

/** Create an invoice (sales order) or bill (purchase order) from an open order. */
export const fulfilOrderSchema = z.object({
  documentDate: isoDateSchema,
  dueDate: isoDateSchema.optional(),
  reference: optionalText(100),
  description: optionalText(500),
  /** Bills only. */
  vendorInvoiceNumber: optionalText(60),
  /** Omit to invoice / bill every outstanding quantity. */
  lines: z.array(fulfilmentLineSchema).max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type FulfilOrderInput = z.infer<typeof fulfilOrderSchema>;

// ------------------------------------------------------------ goods receipts

export const goodsReceiptLineSchema = z.object({
  orderLineId: uuidSchema,
  quantity: quantitySchema,
  notes: optionalText(300),
  /** Lot / serial identification for tracked products (Phase 5). */
  lotNumber: optionalText(60),
  expiryDate: isoDateSchema.nullable().optional(),
  serialNumbers: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
});

export const createGoodsReceiptSchema = z.object({
  purchaseOrderId: uuidSchema,
  receiptDate: isoDateSchema,
  /** Supplier delivery note / packing slip number. */
  reference: optionalText(100),
  notes: optionalText(1000),
  lines: z.array(goodsReceiptLineSchema).min(1, 'Receive at least one line').max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;
export const updateGoodsReceiptSchema = createGoodsReceiptSchema
  .omit({ purchaseOrderId: true, idempotencyKey: true })
  .partial();
export type UpdateGoodsReceiptInput = z.infer<typeof updateGoodsReceiptSchema>;

export const listGoodsReceiptsQuerySchema = paginationQuerySchema.extend({
  purchaseOrderId: uuidSchema.optional(),
  vendorId: uuidSchema.optional(),
  status: z.enum(GOODS_RECEIPT_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListGoodsReceiptsQuery = z.infer<typeof listGoodsReceiptsQuerySchema>;

// ------------------------------------------------------------------- returns

export const returnLineSchema = z.object({
  orderLineId: uuidSchema,
  quantity: quantitySchema,
  reason: optionalText(300),
  lotNumber: optionalText(60),
  serialNumbers: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
});

export const createReturnSchema = z.object({
  orderId: uuidSchema,
  returnDate: isoDateSchema,
  reference: optionalText(100),
  reason: optionalText(500),
  lines: z.array(returnLineSchema).min(1, 'Return at least one line').max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export const updateReturnSchema = createReturnSchema
  .omit({ orderId: true, idempotencyKey: true })
  .partial();
export type UpdateReturnInput = z.infer<typeof updateReturnSchema>;

export const listReturnsQuerySchema = paginationQuerySchema.extend({
  returnType: z.enum(RETURN_TYPES).optional(),
  partyId: uuidSchema.optional(),
  orderId: uuidSchema.optional(),
  status: z.enum(RETURN_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListReturnsQuery = z.infer<typeof listReturnsQuerySchema>;

/** Issuing the credit note for an approved return. */
export const creditReturnSchema = z.object({
  documentDate: isoDateSchema.optional(),
});
export type CreditReturnInput = z.infer<typeof creditReturnSchema>;

// ------------------------------------------------------ purchasing settings

export const purchasingSettingsSchema = z.object({
  /** Allowed unit-price variance between the purchase order and the bill. */
  priceTolerancePercent: percentSchema.default('0'),
  /** Allowed quantity variance between received and billed quantities. */
  quantityTolerancePercent: percentSchema.default('0'),
  /** How much more than ordered a receipt may record. */
  overReceiptTolerancePercent: percentSchema.default('0'),
  /** Flag bills without a purchase order as a matching exception. */
  requirePurchaseOrder: z.boolean().default(false),
  /** Flag bills whose quantities have not been received yet. */
  requireReceiptBeforeBill: z.boolean().default(true),
});
export type PurchasingSettingsInput = z.infer<typeof purchasingSettingsSchema>;

export const matchReviewSchema = z.object({
  note: z.string().trim().min(1, 'A review note is required').max(1000),
});
export type MatchReviewInput = z.infer<typeof matchReviewSchema>;
