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
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ADJUSTMENT_REASONS,
  COSTING_METHODS,
  MOVEMENT_SOURCE_TYPES,
  MOVEMENT_TYPES,
  PRODUCT_TYPES,
  SERIAL_STATUSES,
  STOCK_DIRECTIONS,
  STOCK_DOCUMENT_STATUSES,
  STOCK_DOCUMENT_TYPES,
  TRACKING_MODES,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { branches, companies } from './organizations';
import { revenuePolicies } from './revenue';
import { users } from './users';

export const productTypeEnum = pgEnum('product_type', PRODUCT_TYPES);
export const trackingModeEnum = pgEnum('tracking_mode', TRACKING_MODES);
export const costingMethodEnum = pgEnum('costing_method', COSTING_METHODS);
export const movementTypeEnum = pgEnum('movement_type', MOVEMENT_TYPES);
export const movementSourceTypeEnum = pgEnum('movement_source_type', MOVEMENT_SOURCE_TYPES);
export const stockDocumentTypeEnum = pgEnum('stock_document_type', STOCK_DOCUMENT_TYPES);
export const stockDocumentStatusEnum = pgEnum('stock_document_status', STOCK_DOCUMENT_STATUSES);
export const adjustmentReasonEnum = pgEnum('adjustment_reason', ADJUSTMENT_REASONS);
export const serialStatusEnum = pgEnum('serial_status', SERIAL_STATUSES);
export const stockDirectionEnum = pgEnum('stock_direction', STOCK_DIRECTIONS);

/** Optional GL overrides carried by categories and products; company mappings are the fallback. */
const accountOverrides = () => ({
  inventoryAccountId: uuid('inventory_account_id').references(() => accounts.id, {
    onDelete: 'restrict',
  }),
  cogsAccountId: uuid('cogs_account_id').references(() => accounts.id, { onDelete: 'restrict' }),
  revenueAccountId: uuid('revenue_account_id').references(() => accounts.id, {
    onDelete: 'restrict',
  }),
  expenseAccountId: uuid('expense_account_id').references(() => accounts.id, {
    onDelete: 'restrict',
  }),
});

export const productCategories = pgTable(
  'product_categories',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    parentId: uuid('parent_id').references((): AnyPgColumn => productCategories.id, {
      onDelete: 'restrict',
    }),
    ...accountOverrides(),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('product_categories_company_code_uq').on(t.companyId, t.code)],
);

export const products = pgTable(
  'products',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    categoryId: uuid('category_id').references(() => productCategories.id, {
      onDelete: 'restrict',
    }),
    productType: productTypeEnum('product_type').notNull().default('GOODS'),
    trackingMode: trackingModeEnum('tracking_mode').notNull().default('NONE'),
    /** Null = company default at the time of each movement. */
    costingMethod: costingMethodEnum('costing_method'),
    unitOfMeasure: text('unit_of_measure').notNull().default('pc'),
    barcode: text('barcode'),
    salePrice: money('sale_price'),
    /** Revenue recognition policy applied to invoice lines of this product (Prompt #10). */
    revenuePolicyId: uuid('revenue_policy_id').references((): AnyPgColumn => revenuePolicies.id, {
      onDelete: 'set null',
    }),
    purchasePrice: money('purchase_price'),
    standardCost: money('standard_cost'),
    reorderLevel: money('reorder_level'),
    reorderQuantity: money('reorder_quantity'),
    ...accountOverrides(),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('products_company_sku_uq').on(t.companyId, t.sku),
    index('products_company_name_idx').on(t.companyId, t.name),
    check(
      'products_prices_chk',
      sql`(${t.salePrice} IS NULL OR ${t.salePrice} >= 0) AND (${t.purchasePrice} IS NULL OR ${t.purchasePrice} >= 0) AND (${t.standardCost} IS NULL OR ${t.standardCost} >= 0)`,
    ),
  ],
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    addressLine1: text('address_line1'),
    city: text('city'),
    notes: text('notes'),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('warehouses_company_code_uq').on(t.companyId, t.code)],
);

export const warehouseLocations = pgTable(
  'warehouse_locations',
  {
    id: primaryId(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('warehouse_locations_code_uq').on(t.warehouseId, t.code)],
);

export const inventorySettings = pgTable('inventory_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  defaultCostingMethod: costingMethodEnum('default_costing_method')
    .notNull()
    .default('WEIGHTED_AVERAGE'),
  allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
  ...timestamps,
});

/** A batch of a lot-tracked product. Quantities live in balances / layers keyed by lot. */
export const stockLots = pgTable(
  'stock_lots',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    lotNumber: text('lot_number').notNull(),
    expiryDate: date('expiry_date'),
    ...timestamps,
  },
  (t) => [uniqueIndex('stock_lots_product_number_uq').on(t.productId, t.lotNumber)],
);

/**
 * Every quantity change, valued. Append-only: corrections are opposite
 * movements. `journal_entry_id` links to the ledger effect when there is one.
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => warehouseLocations.id, {
      onDelete: 'set null',
    }),
    lotId: uuid('lot_id').references(() => stockLots.id, { onDelete: 'restrict' }),
    movementType: movementTypeEnum('movement_type').notNull(),
    movementDate: date('movement_date').notNull(),
    /** Always positive; the type gives the direction. */
    quantity: money('quantity').notNull(),
    unitCost: money('unit_cost').notNull(),
    totalCost: money('total_cost').notNull(),
    /** Running quantity for the product/warehouse/lot after this movement. */
    balanceAfter: money('balance_after').notNull(),
    sourceType: movementSourceTypeEnum('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceLineId: uuid('source_line_id'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    /** Movement this one reverses (void / cancel). */
    reversesMovementId: uuid('reverses_movement_id').references(
      (): AnyPgColumn => inventoryMovements.id,
      { onDelete: 'restrict' },
    ),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_movements_product_wh_idx').on(t.productId, t.warehouseId, t.movementDate),
    index('inventory_movements_source_idx').on(t.sourceType, t.sourceId),
    index('inventory_movements_company_date_idx').on(t.companyId, t.movementDate),
    check(
      'inventory_movements_qty_chk',
      sql`${t.quantity} > 0 AND ${t.unitCost} >= 0 AND ${t.totalCost} >= 0`,
    ),
  ],
);

/** FIFO cost layers: one per inbound movement, consumed oldest first. */
export const inventoryLayers = pgTable(
  'inventory_layers',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id').references(() => stockLots.id, { onDelete: 'restrict' }),
    movementId: uuid('movement_id')
      .notNull()
      .references(() => inventoryMovements.id, { onDelete: 'restrict' }),
    receivedDate: date('received_date').notNull(),
    /** Sequence within a day so consumption is deterministic. */
    sequence: integer('sequence').notNull(),
    quantityReceived: money('quantity_received').notNull(),
    quantityRemaining: money('quantity_remaining').notNull(),
    unitCost: money('unit_cost').notNull(),
  },
  (t) => [
    index('inventory_layers_open_idx').on(
      t.productId,
      t.warehouseId,
      t.lotId,
      t.receivedDate,
      t.sequence,
    ),
    check(
      'inventory_layers_qty_chk',
      sql`${t.quantityReceived} > 0 AND ${t.quantityRemaining} >= 0 AND ${t.quantityRemaining} <= ${t.quantityReceived}`,
    ),
  ],
);

/** Current quantity and value per product / warehouse / lot - the inventory subledger. */
export const inventoryBalances = pgTable(
  'inventory_balances',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id').references(() => stockLots.id, { onDelete: 'restrict' }),
    quantityOnHand: money('quantity_on_hand').notNull().default('0'),
    totalCost: money('total_cost').notNull().default('0'),
    ...timestamps,
  },
  (t) => [
    unique('inventory_balances_uq').on(t.productId, t.warehouseId, t.lotId).nullsNotDistinct(),
    index('inventory_balances_company_idx').on(t.companyId),
  ],
);

export const serialNumbers = pgTable(
  'serial_numbers',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    serial: text('serial').notNull(),
    status: serialStatusEnum('status').notNull().default('IN_STOCK'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    lotId: uuid('lot_id').references(() => stockLots.id, { onDelete: 'restrict' }),
    lastMovementId: uuid('last_movement_id').references(() => inventoryMovements.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [uniqueIndex('serial_numbers_product_serial_uq').on(t.productId, t.serial)],
);

export const movementSerials = pgTable(
  'movement_serials',
  {
    movementId: uuid('movement_id')
      .notNull()
      .references(() => inventoryMovements.id, { onDelete: 'cascade' }),
    serialId: uuid('serial_id')
      .notNull()
      .references(() => serialNumbers.id, { onDelete: 'restrict' }),
  },
  (t) => [uniqueIndex('movement_serials_uq').on(t.movementId, t.serialId)],
);

/** Adjustments, transfers and counts. Posting creates the movements (and journal) atomically. */
export const stockDocuments = pgTable(
  'stock_documents',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentType: stockDocumentTypeEnum('document_type').notNull(),
    documentNumber: text('document_number').notNull(),
    status: stockDocumentStatusEnum('status').notNull().default('DRAFT'),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    /** Transfers only. */
    toWarehouseId: uuid('to_warehouse_id').references(() => warehouses.id, {
      onDelete: 'restrict',
    }),
    documentDate: date('document_date').notNull(),
    reason: adjustmentReasonEnum('reason'),
    reference: text('reference'),
    notes: text('notes'),
    currency: text('currency').notNull(),
    /** Net value moved (adjustment gain/loss or transfer value). */
    totalCost: money('total_cost').notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    cancelReason: text('cancel_reason'),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('stock_documents_company_number_uq').on(t.companyId, t.documentNumber),
    uniqueIndex('stock_documents_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('stock_documents_company_type_status_idx').on(t.companyId, t.documentType, t.status),
    check(
      'stock_documents_transfer_chk',
      sql`(${t.documentType} = 'TRANSFER' AND ${t.toWarehouseId} IS NOT NULL AND ${t.toWarehouseId} <> ${t.warehouseId}) OR (${t.documentType} <> 'TRANSFER' AND ${t.toWarehouseId} IS NULL)`,
    ),
  ],
);

export const stockDocumentLines = pgTable(
  'stock_document_lines',
  {
    id: primaryId(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => stockDocuments.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => warehouseLocations.id, {
      onDelete: 'set null',
    }),
    lotNumber: text('lot_number'),
    expiryDate: date('expiry_date'),
    serialNumbers: jsonb('serial_numbers').$type<string[]>().notNull().default([]),
    /** Adjustments: IN / OUT. Transfers: always OUT of the source. Counts: derived from the variance. */
    direction: stockDirectionEnum('direction').notNull().default('OUT'),
    quantity: money('quantity').notNull(),
    /** Counts: snapshot of the system quantity when the count was created, and what was counted. */
    expectedQuantity: money('expected_quantity'),
    countedQuantity: money('counted_quantity'),
    /** Cost per unit applied on posting (input for IN, computed for OUT). */
    unitCost: money('unit_cost'),
    totalCost: money('total_cost'),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('stock_document_lines_number_uq').on(t.documentId, t.lineNumber),
    check('stock_document_lines_qty_chk', sql`${t.quantity} >= 0`),
  ],
);

export type ProductCategory = typeof productCategories.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Warehouse = typeof warehouses.$inferSelect;
export type WarehouseLocation = typeof warehouseLocations.$inferSelect;
export type InventorySettingsRow = typeof inventorySettings.$inferSelect;
export type StockLot = typeof stockLots.$inferSelect;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InventoryLayer = typeof inventoryLayers.$inferSelect;
export type InventoryBalance = typeof inventoryBalances.$inferSelect;
export type SerialNumber = typeof serialNumbers.$inferSelect;
export type StockDocument = typeof stockDocuments.$inferSelect;
export type StockDocumentLine = typeof stockDocumentLines.$inferSelect;
