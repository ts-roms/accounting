import { z } from 'zod';
import {
  ADJUSTMENT_REASONS,
  COSTING_METHODS,
  ENTITY_STATUSES,
  PRODUCT_TYPES,
  STOCK_DOCUMENT_STATUSES,
  TRACKING_MODES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting.js';
import {
  codeSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  queryBooleanSchema,
  uuidSchema,
} from './primitives.js';
import { quantitySchema } from './subledger.js';

// ------------------------------------------------------------------ products

export const createProductCategorySchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: optionalText(500),
  parentId: uuidSchema.nullable().optional(),
  /** Default GL accounts for products in this category (override the company mappings). */
  inventoryAccountId: uuidSchema.nullable().optional(),
  cogsAccountId: uuidSchema.nullable().optional(),
  revenueAccountId: uuidSchema.nullable().optional(),
  expenseAccountId: uuidSchema.nullable().optional(),
});
export type CreateProductCategoryInput = z.infer<typeof createProductCategorySchema>;
export const updateProductCategorySchema = createProductCategorySchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateProductCategoryInput = z.infer<typeof updateProductCategorySchema>;

export const createProductSchema = z.object({
  sku: codeSchema,
  name: nameSchema,
  description: optionalText(1000),
  categoryId: uuidSchema.nullable().optional(),
  productType: z.enum(PRODUCT_TYPES).default('GOODS'),
  trackingMode: z.enum(TRACKING_MODES).default('NONE'),
  /** Omit to use the company default. */
  costingMethod: z.enum(COSTING_METHODS).nullable().optional(),
  unitOfMeasure: z.string().trim().min(1).max(20).default('pc'),
  barcode: optionalText(64),
  salePrice: amountSchema.nullable().optional(),
  purchasePrice: amountSchema.nullable().optional(),
  /** Used when stock is issued with no cost basis (negative stock allowed). */
  standardCost: amountSchema.nullable().optional(),
  reorderLevel: quantitySchema.nullable().optional(),
  reorderQuantity: quantitySchema.nullable().optional(),
  inventoryAccountId: uuidSchema.nullable().optional(),
  cogsAccountId: uuidSchema.nullable().optional(),
  revenueAccountId: uuidSchema.nullable().optional(),
  expenseAccountId: uuidSchema.nullable().optional(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;
export const updateProductSchema = createProductSchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listProductsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ENTITY_STATUSES).optional(),
  productType: z.enum(PRODUCT_TYPES).optional(),
  categoryId: uuidSchema.optional(),
  /** Only products at or below their reorder level. */
  belowReorder: queryBooleanSchema.optional(),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// ---------------------------------------------------------------- warehouses

export const createWarehouseSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  branchId: uuidSchema.nullable().optional(),
  addressLine1: optionalText(200),
  city: optionalText(100),
  notes: optionalText(500),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export const updateWarehouseSchema = createWarehouseSchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

export const createLocationSchema = z.object({
  code: codeSchema,
  name: nameSchema,
});
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

// -------------------------------------------------------------------- stock

/** Lot / serial identification shared by every stock-moving line. */
export const stockIdentitySchema = z.object({
  lotNumber: optionalText(60),
  expiryDate: isoDateSchema.nullable().optional(),
  serialNumbers: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
});

export const adjustmentLineSchema = stockIdentitySchema.extend({
  productId: uuidSchema,
  locationId: uuidSchema.nullable().optional(),
  direction: z.enum(['IN', 'OUT']),
  quantity: quantitySchema,
  /** Required for IN adjustments (what the stock is worth); ignored for OUT (valued at cost). */
  unitCost: amountSchema.optional(),
  notes: optionalText(300),
});

export const createAdjustmentSchema = z.object({
  warehouseId: uuidSchema,
  documentDate: isoDateSchema,
  reason: z.enum(ADJUSTMENT_REASONS).default('CORRECTION'),
  reference: optionalText(100),
  notes: optionalText(1000),
  lines: z.array(adjustmentLineSchema).min(1, 'At least one line is required').max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

export const transferLineSchema = stockIdentitySchema.extend({
  productId: uuidSchema,
  quantity: quantitySchema,
  notes: optionalText(300),
});

export const createTransferSchema = z.object({
  warehouseId: uuidSchema,
  toWarehouseId: uuidSchema,
  documentDate: isoDateSchema,
  reference: optionalText(100),
  notes: optionalText(1000),
  lines: z.array(transferLineSchema).min(1, 'At least one line is required').max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

export const countLineSchema = z.object({
  productId: uuidSchema,
  lotNumber: optionalText(60),
  countedQuantity: z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,4})?$/, 'Quantity must be a non-negative decimal'),
  /** Cost applied to found quantities (defaults to the current average / last cost). */
  unitCost: amountSchema.optional(),
  notes: optionalText(300),
});

export const createCountSchema = z.object({
  warehouseId: uuidSchema,
  documentDate: isoDateSchema,
  reference: optionalText(100),
  notes: optionalText(1000),
  lines: z.array(countLineSchema).min(1, 'At least one line is required').max(2000),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateCountInput = z.infer<typeof createCountSchema>;

export const updateStockDocumentSchema = z.object({
  documentDate: isoDateSchema.optional(),
  reference: optionalText(100),
  notes: optionalText(1000),
  reason: z.enum(ADJUSTMENT_REASONS).optional(),
});
export type UpdateStockDocumentInput = z.infer<typeof updateStockDocumentSchema>;

export const listStockDocumentsQuerySchema = paginationQuerySchema.extend({
  warehouseId: uuidSchema.optional(),
  status: z.enum(STOCK_DOCUMENT_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListStockDocumentsQuery = z.infer<typeof listStockDocumentsQuerySchema>;

export const inventorySettingsSchema = z.object({
  defaultCostingMethod: z.enum(COSTING_METHODS).default('WEIGHTED_AVERAGE'),
  /** When false (default) an issue that would drive stock negative is rejected. */
  allowNegativeStock: z.boolean().default(false),
});
export type InventorySettingsInput = z.infer<typeof inventorySettingsSchema>;

export const stockOnHandQuerySchema = z.object({
  warehouseId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
  categoryId: uuidSchema.optional(),
  search: z.string().trim().max(200).optional(),
  /** Include zero-quantity rows. */
  includeZero: queryBooleanSchema.optional(),
});
export type StockOnHandQuery = z.infer<typeof stockOnHandQuerySchema>;

export const stockCardQuerySchema = paginationQuerySchema.extend({
  productId: uuidSchema,
  warehouseId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type StockCardQuery = z.infer<typeof stockCardQuerySchema>;

export const valuationQuerySchema = z.object({ asOf: isoDateSchema });
export type ValuationQuery = z.infer<typeof valuationQuerySchema>;
