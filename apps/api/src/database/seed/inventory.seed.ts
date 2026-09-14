import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import * as schema from '../schema';
import type { Tx } from './seed';

type Log = (m: string) => void;

/**
 * Phase 5 sample master data for every company (warehouses, categories,
 * products) and, for ACME, an opening stock balance that ties to the
 * inventory value already sitting in the general ledger from the Phase 2/3
 * sample journals (100,000 merchandise purchased - 60,000 COGS = 40,000).
 * The opening movement therefore posts no journal of its own.
 */

const WAREHOUSES = [
  { code: 'MAIN', name: 'Main Warehouse', city: 'Makati' },
  { code: 'BR01', name: 'Cebu Branch Store', city: 'Cebu' },
];

const CATEGORIES = [
  { code: 'MERCH', name: 'Merchandise', description: 'Goods for resale' },
  { code: 'EQUIP', name: 'Equipment', description: 'IT and office equipment' },
  { code: 'SVC', name: 'Services', description: 'Non-stock services' },
];

const PRODUCTS: Array<typeof schema.products.$inferInsert & { category: string }> = [
  {
    companyId: '',
    sku: 'MERCH-001',
    name: 'Merchandise unit (generic)',
    category: 'MERCH',
    productType: 'GOODS',
    trackingMode: 'NONE',
    costingMethod: 'WEIGHTED_AVERAGE',
    unitOfMeasure: 'pc',
    salePrice: '350',
    purchasePrice: '200',
    reorderLevel: '100',
    reorderQuantity: '500',
  },
  {
    companyId: '',
    sku: 'MERCH-002',
    name: 'Heavy-duty shelving bay',
    category: 'MERCH',
    productType: 'GOODS',
    trackingMode: 'NONE',
    costingMethod: 'FIFO',
    unitOfMeasure: 'set',
    salePrice: '18500',
    purchasePrice: '12000',
    reorderLevel: '5',
    reorderQuantity: '10',
  },
  {
    companyId: '',
    sku: 'MERCH-003',
    name: 'Thermal paper roll 80mm',
    category: 'MERCH',
    productType: 'GOODS',
    trackingMode: 'LOT',
    unitOfMeasure: 'box',
    salePrice: '450',
    purchasePrice: '280',
    reorderLevel: '50',
    reorderQuantity: '200',
  },
  {
    companyId: '',
    sku: 'EQUIP-001',
    name: 'Business laptop 14"',
    category: 'EQUIP',
    productType: 'GOODS',
    trackingMode: 'SERIAL',
    costingMethod: 'FIFO',
    unitOfMeasure: 'unit',
    salePrice: '78000',
    purchasePrice: '65000',
  },
  {
    companyId: '',
    sku: 'SVC-001',
    name: 'Installation service (per hour)',
    category: 'SVC',
    productType: 'SERVICE',
    trackingMode: 'NONE',
    unitOfMeasure: 'hr',
    salePrice: '1500',
  },
];

export async function seedInventory(
  tx: Tx,
  company: schema.Company,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const warehouseIds = new Map<string, string>();
  for (const w of WAREHOUSES) {
    const [existing] = await tx
      .select({ id: schema.warehouses.id })
      .from(schema.warehouses)
      .where(and(eq(schema.warehouses.companyId, company.id), eq(schema.warehouses.code, w.code)));
    if (existing) {
      warehouseIds.set(w.code, existing.id);
      continue;
    }
    const [row] = await tx
      .insert(schema.warehouses)
      .values({ companyId: company.id, ...w })
      .returning({ id: schema.warehouses.id });
    warehouseIds.set(w.code, row!.id);
  }
  const categoryIds = new Map<string, string>();
  for (const c of CATEGORIES) {
    const [existing] = await tx
      .select({ id: schema.productCategories.id })
      .from(schema.productCategories)
      .where(
        and(
          eq(schema.productCategories.companyId, company.id),
          eq(schema.productCategories.code, c.code),
        ),
      );
    if (existing) {
      categoryIds.set(c.code, existing.id);
      continue;
    }
    const [row] = await tx
      .insert(schema.productCategories)
      .values({ companyId: company.id, ...c })
      .returning({ id: schema.productCategories.id });
    categoryIds.set(c.code, row!.id);
  }
  const productIds = new Map<string, string>();
  for (const { category, ...p } of PRODUCTS) {
    const [existing] = await tx
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.companyId, company.id), eq(schema.products.sku, p.sku)));
    if (existing) {
      productIds.set(p.sku, existing.id);
      continue;
    }
    const [row] = await tx
      .insert(schema.products)
      .values({ ...p, companyId: company.id, categoryId: categoryIds.get(category) ?? null })
      .returning({ id: schema.products.id });
    productIds.set(p.sku, row!.id);
  }
  await tx
    .insert(schema.inventorySettings)
    .values({
      companyId: company.id,
      defaultCostingMethod: 'WEIGHTED_AVERAGE',
      allowNegativeStock: false,
    })
    .onConflictDoNothing();
  log(
    `inventory master data ensured for ${company.code} (${WAREHOUSES.length} warehouses, ${PRODUCTS.length} products)`,
  );

  if (company.code !== 'ACME') return;
  const productId = productIds.get('MERCH-001')!;
  const warehouseId = warehouseIds.get('MAIN')!;
  const [anyMovement] = await tx
    .select({ id: schema.inventoryMovements.id })
    .from(schema.inventoryMovements)
    .where(eq(schema.inventoryMovements.companyId, company.id))
    .limit(1);
  if (anyMovement) return;

  // Opening stock: 200 units @ 200.00 = 40,000.00 - the inventory value already in the GL.
  const currency = company.baseCurrency;
  const quantity = Money.of('200', currency);
  const unitCost = Money.of('200', currency);
  const totalCost = unitCost.multiply(quantity.toString());
  const openingDate = '2026-01-31';
  const [doc] = await tx
    .insert(schema.stockDocuments)
    .values({
      companyId: company.id,
      documentType: 'ADJUSTMENT',
      documentNumber: 'ADJ-2026-000000',
      status: 'POSTED',
      warehouseId,
      documentDate: openingDate,
      reason: 'CORRECTION',
      reference: 'OPENING',
      notes: 'Opening stock - value carried in the ledger by the sample purchase and COGS journals',
      currency,
      totalCost: totalCost.toString(),
      postedBy: adminUserId,
      postedAt: new Date(),
      createdBy: adminUserId,
    })
    .returning({ id: schema.stockDocuments.id });
  const [line] = await tx
    .insert(schema.stockDocumentLines)
    .values({
      documentId: doc!.id,
      lineNumber: 1,
      productId,
      direction: 'IN',
      quantity: quantity.toString(),
      unitCost: unitCost.toString(),
      totalCost: totalCost.toString(),
      notes: 'Opening balance',
    })
    .returning({ id: schema.stockDocumentLines.id });
  const [movement] = await tx
    .insert(schema.inventoryMovements)
    .values({
      companyId: company.id,
      productId,
      warehouseId,
      movementType: 'ADJUSTMENT_IN',
      movementDate: openingDate,
      quantity: quantity.toString(),
      unitCost: unitCost.toString(),
      totalCost: totalCost.toString(),
      balanceAfter: quantity.toString(),
      sourceType: 'STOCK_ADJUSTMENT',
      sourceId: doc!.id,
      sourceLineId: line!.id,
      notes: 'Opening balance',
      createdBy: adminUserId,
    })
    .returning({ id: schema.inventoryMovements.id });
  await tx.insert(schema.inventoryLayers).values({
    companyId: company.id,
    productId,
    warehouseId,
    movementId: movement!.id,
    receivedDate: openingDate,
    sequence: 1,
    quantityReceived: quantity.toString(),
    quantityRemaining: quantity.toString(),
    unitCost: unitCost.toString(),
  });
  await tx.insert(schema.inventoryBalances).values({
    companyId: company.id,
    productId,
    warehouseId,
    quantityOnHand: quantity.toString(),
    totalCost: totalCost.toString(),
  });
  log(`opening stock seeded for ${company.code}: 200 x MERCH-001 @ 200.00`);
}
