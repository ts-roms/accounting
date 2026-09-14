/** Shared enumerations for inventory (mirrored as PostgreSQL enums). */

export const PRODUCT_TYPES = ['GOODS', 'SERVICE'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** How units of a product are identified in stock. */
export const TRACKING_MODES = ['NONE', 'LOT', 'SERIAL'] as const;
export type TrackingMode = (typeof TRACKING_MODES)[number];

/** Valuation method; chosen per product, defaulted from the company's inventory settings. */
export const COSTING_METHODS = ['FIFO', 'WEIGHTED_AVERAGE'] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];

export const MOVEMENT_TYPES = [
  'RECEIPT',
  'ISSUE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'RETURN_IN',
  'RETURN_OUT',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const INBOUND_MOVEMENT_TYPES: readonly MovementType[] = [
  'RECEIPT',
  'TRANSFER_IN',
  'ADJUSTMENT_IN',
  'RETURN_IN',
];

export function isInbound(type: MovementType): boolean {
  return INBOUND_MOVEMENT_TYPES.includes(type);
}

/** Documents that move stock without a sale or purchase. */
export const STOCK_DOCUMENT_TYPES = ['ADJUSTMENT', 'TRANSFER', 'COUNT'] as const;
export type StockDocumentType = (typeof STOCK_DOCUMENT_TYPES)[number];

export const STOCK_DOCUMENT_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type StockDocumentStatus = (typeof STOCK_DOCUMENT_STATUSES)[number];

export const ADJUSTMENT_REASONS = [
  'DAMAGE',
  'SHRINKAGE',
  'EXPIRY',
  'COUNT_VARIANCE',
  'CORRECTION',
  'FOUND',
  'OTHER',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const SERIAL_STATUSES = ['IN_STOCK', 'ISSUED'] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];

export const STOCK_DIRECTIONS = ['IN', 'OUT'] as const;
export type StockDirection = (typeof STOCK_DIRECTIONS)[number];

/** Business sources that move stock (mirrors `inventory_movements.source_type`). */
export const MOVEMENT_SOURCE_TYPES = [
  'GOODS_RECEIPT',
  'GOODS_RECEIPT_CANCEL',
  'AR_DOCUMENT',
  'AR_DOCUMENT_VOID',
  'AP_DOCUMENT',
  'AP_DOCUMENT_VOID',
  'STOCK_ADJUSTMENT',
  'STOCK_TRANSFER',
  'STOCK_COUNT',
] as const;
export type MovementSourceType = (typeof MOVEMENT_SOURCE_TYPES)[number];
