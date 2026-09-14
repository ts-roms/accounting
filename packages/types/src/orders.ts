/** Shared enumerations for sales & purchasing documents (mirrored as PostgreSQL enums). */

/**
 * One `orders` table holds every commercial document that precedes an AR/AP
 * document. The type decides the party (customer or vendor), the lifecycle and
 * which fulfilment counters apply.
 */
export const ORDER_TYPES = [
  'QUOTATION',
  'SALES_ORDER',
  'PURCHASE_REQUEST',
  'PURCHASE_ORDER',
] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = [
  'DRAFT',
  /** Purchase request awaiting approval. */
  'SUBMITTED',
  /** Quotation sent to the customer. */
  'SENT',
  /** Quotation accepted by the customer (ready to convert). */
  'ACCEPTED',
  /** Sales / purchase order approved (open for invoicing, receiving, billing). */
  'APPROVED',
  /** Quotation or purchase request turned into an order. */
  'CONVERTED',
  'REJECTED',
  /** Fully fulfilled or manually closed - no further activity. */
  'CLOSED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Progress of receiving (purchase orders) and invoicing / billing (sales and purchase orders). */
export const FULFILLMENT_STATUSES = ['NONE', 'PARTIAL', 'FULL'] as const;
export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export const GOODS_RECEIPT_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

/** SALES = customer returns goods (credit note to the customer); PURCHASE = goods returned to a vendor. */
export const RETURN_TYPES = ['SALES', 'PURCHASE'] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];

export const RETURN_STATUSES = ['DRAFT', 'APPROVED', 'CREDITED', 'CANCELLED'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

/** Three-way match result stored on a vendor bill. */
export const MATCH_STATUSES = [
  /** Bill not linked to a purchase order and no PO required. */
  'NOT_REQUIRED',
  'MATCHED',
  /** One or more exceptions - payment is on hold until reviewed. */
  'EXCEPTION',
  /** Exceptions acknowledged by an approver; payment may proceed. */
  'REVIEWED',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_EXCEPTION_CODES = [
  'QUANTITY_MISMATCH',
  'PRICE_MISMATCH',
  'MISSING_RECEIPT',
  'MISSING_PURCHASE_ORDER',
  'DUPLICATE_INVOICE',
] as const;
export type MatchExceptionCode = (typeof MATCH_EXCEPTION_CODES)[number];

export interface MatchException {
  code: MatchExceptionCode;
  message: string;
  lineNumber?: number;
  details: Record<string, string>;
}

/** Order statuses that still allow fulfilment (invoicing, receiving, billing). */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ['APPROVED'];
