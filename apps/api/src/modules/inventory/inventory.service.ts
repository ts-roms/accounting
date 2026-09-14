import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import {
  isInbound,
  type CostingMethod,
  type MovementSourceType,
  type MovementType,
} from '@accounting/types';
import type { InventorySettingsInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  inventoryBalances,
  inventoryLayers,
  inventoryMovements,
  inventorySettings,
  movementSerials,
  productCategories,
  products,
  serialNumbers,
  stockLots,
  warehouses,
  type InventoryBalance,
  type InventoryMovement,
  type InventorySettingsRow,
  type Product,
  type Warehouse,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AuditService } from '@/modules/audit/audit.service';
import {
  applyIssue,
  applyReceipt,
  averageCost,
  consumeFifo,
  issueWeightedAverage,
  unitCostOf,
} from './valuation';

const MODULE = 'INVENTORY';

export interface StockIdentity {
  lotNumber?: string | null;
  expiryDate?: string | null;
  serialNumbers?: string[] | null;
}

export interface MoveStockInput extends StockIdentity {
  companyId: string;
  productId: string;
  warehouseId: string;
  locationId?: string | null;
  quantity: string;
  movementDate: string;
  movementType: MovementType;
  sourceType: MovementSourceType;
  sourceId: string;
  sourceLineId?: string | null;
  actorId: string;
  notes?: string | null;
  /** Inbound: the unit cost received. Outbound: forces a cost instead of valuation (reversals). */
  unitCost?: Money;
  /** Reversals: move exactly the original value (unit cost x quantity may round differently). */
  totalCostOverride?: Money;
  /** Outbound: relieve this specific layer first (reversal of a receipt). */
  preferLayerId?: string | null;
  reversesMovementId?: string | null;
}

export interface MoveStockResult {
  movementId: string;
  quantity: Money;
  unitCost: Money;
  totalCost: Money;
  lotId: string | null;
}

/** Product with its resolved GL accounts (product -> category -> company mapping). */
export interface ResolvedProduct extends Product {
  accounts: { inventory: string; cogs: string; revenue: string | null; expense: string | null };
  costing: CostingMethod;
}

/**
 * The inventory subledger. Every stock quantity change goes through `receive`
 * or `issue`, which write the movement, maintain FIFO layers and the
 * product / warehouse / lot balance, and return the exact cost so the caller
 * can post the matching journal lines in the same transaction. The sum of
 * balance values must always equal the inventory control account(s).
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  // ---------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<InventorySettingsRow> {
    const [row] = await executor
      .select()
      .from(inventorySettings)
      .where(eq(inventorySettings.companyId, companyId));
    return (
      row ?? {
        companyId,
        defaultCostingMethod: 'WEIGHTED_AVERAGE',
        allowNegativeStock: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    );
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: InventorySettingsInput,
  ): Promise<InventorySettingsRow> {
    return this.db.transaction(async (tx) => {
      const previous = await this.settings(companyId, tx);
      const [row] = await tx
        .insert(inventorySettings)
        .values({ companyId, ...input })
        .onConflictDoUpdate({ target: inventorySettings.companyId, set: { ...input } })
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'InventorySettings',
          entityId: companyId,
          previousValue: {
            defaultCostingMethod: previous.defaultCostingMethod,
            allowNegativeStock: previous.allowNegativeStock,
          },
          newValue: input,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  // ---------------------------------------------------------------- lookups

  /** Product with accounts resolved through category and company mappings. Throws for unknown / inactive. */
  async resolveProduct(
    companyId: string,
    productId: string,
    executor: DbExecutor = this.db,
    options: { allowInactive?: boolean } = {},
  ): Promise<ResolvedProduct> {
    const [product] = await executor
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.companyId, companyId)));
    if (!product) throw new NotFoundError('Product', productId);
    if (product.status !== 'ACTIVE' && !options.allowInactive) {
      throw new BusinessRuleError(ErrorCodes.PARTY_INACTIVE, `Product ${product.sku} is inactive.`);
    }
    const category = product.categoryId
      ? (
          await executor
            .select()
            .from(productCategories)
            .where(eq(productCategories.id, product.categoryId))
        )[0]
      : undefined;
    const mapped = async (key: 'INVENTORY' | 'COST_OF_GOODS_SOLD') =>
      (await this.accounts.resolveMapped(companyId, key, executor)).id;
    // Revenue / expense defaults are conveniences for line entry; they may be unmapped.
    const optional = async (key: 'SALES_REVENUE' | 'DEFAULT_EXPENSE') => {
      try {
        return (await this.accounts.resolveMapped(companyId, key, executor)).id;
      } catch {
        return null;
      }
    };
    const settings = await this.settings(companyId, executor);
    return {
      ...product,
      costing: product.costingMethod ?? settings.defaultCostingMethod,
      accounts: {
        inventory:
          product.inventoryAccountId ?? category?.inventoryAccountId ?? (await mapped('INVENTORY')),
        cogs:
          product.cogsAccountId ?? category?.cogsAccountId ?? (await mapped('COST_OF_GOODS_SOLD')),
        revenue:
          product.revenueAccountId ??
          category?.revenueAccountId ??
          (await optional('SALES_REVENUE')),
        expense:
          product.expenseAccountId ??
          category?.expenseAccountId ??
          (await optional('DEFAULT_EXPENSE')),
      },
    };
  }

  async resolveWarehouse(
    companyId: string,
    warehouseId: string,
    executor: DbExecutor = this.db,
  ): Promise<Warehouse> {
    const [row] = await executor
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.id, warehouseId), eq(warehouses.companyId, companyId)));
    if (!row) throw new NotFoundError('Warehouse', warehouseId);
    if (row.status !== 'ACTIVE') {
      throw new BusinessRuleError(ErrorCodes.PARTY_INACTIVE, `Warehouse ${row.code} is inactive.`);
    }
    return row;
  }

  /** Current balance row (locked) or a zero balance. */
  async balance(
    tx: DbExecutor,
    productId: string,
    warehouseId: string,
    lotId: string | null,
    lock = false,
  ): Promise<InventoryBalance | null> {
    const where = and(
      eq(inventoryBalances.productId, productId),
      eq(inventoryBalances.warehouseId, warehouseId),
      lotId ? eq(inventoryBalances.lotId, lotId) : isNull(inventoryBalances.lotId),
    );
    const query = tx.select().from(inventoryBalances).where(where);
    const [row] = lock ? await query.for('update') : await query;
    return row ?? null;
  }

  /** On-hand quantity and value for a product across lots in one warehouse (or all warehouses). */
  async onHand(
    companyId: string,
    productId: string,
    warehouseId?: string,
    executor: DbExecutor = this.db,
  ): Promise<{ quantity: string; value: string }> {
    const filters = [
      eq(inventoryBalances.companyId, companyId),
      eq(inventoryBalances.productId, productId),
    ];
    if (warehouseId) filters.push(eq(inventoryBalances.warehouseId, warehouseId));
    const [row] = await executor
      .select({
        quantity: sql<string>`coalesce(sum(${inventoryBalances.quantityOnHand}), 0)`,
        value: sql<string>`coalesce(sum(${inventoryBalances.totalCost}), 0)`,
      })
      .from(inventoryBalances)
      .where(and(...filters));
    return { quantity: row?.quantity ?? '0', value: row?.value ?? '0' };
  }

  /** Movements recorded by a business document (for reversal on void / cancel). */
  async movementsOf(
    tx: DbExecutor,
    sourceType: MovementSourceType,
    sourceId: string,
  ): Promise<InventoryMovement[]> {
    return tx
      .select()
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.sourceType, sourceType),
          eq(inventoryMovements.sourceId, sourceId),
        ),
      )
      .orderBy(asc(inventoryMovements.createdAt));
  }

  async setJournal(tx: DbExecutor, movementIds: string[], journalEntryId: string): Promise<void> {
    if (movementIds.length === 0) return;
    await tx
      .update(inventoryMovements)
      .set({ journalEntryId })
      .where(inArray(inventoryMovements.id, movementIds));
  }

  /** Cost basis used when stock is issued with nothing on hand (negative stock allowed). */
  async fallbackCost(
    tx: DbExecutor,
    product: ResolvedProduct,
    warehouseId: string,
    currency: string,
  ): Promise<Money | null> {
    const settings = await this.settings(product.companyId, tx);
    if (!settings.allowNegativeStock) return null;
    const total = await this.onHand(product.companyId, product.id, undefined, tx);
    const avg = averageCost({ quantityOnHand: total.quantity, totalCost: total.value }, currency);
    if (avg.isPositive()) return avg;
    if (product.standardCost) return Money.of(product.standardCost, currency);
    if (product.purchasePrice) return Money.of(product.purchasePrice, currency);
    void warehouseId;
    return Money.zero(currency);
  }

  /** Current average cost (falls back to standard / purchase price) - used to value returns coming back. */
  async currentCost(
    tx: DbExecutor,
    product: ResolvedProduct,
    warehouseId: string,
    currency: string,
  ): Promise<Money> {
    const local = await this.onHand(product.companyId, product.id, warehouseId, tx);
    const localAvg = averageCost(
      { quantityOnHand: local.quantity, totalCost: local.value },
      currency,
    );
    if (localAvg.isPositive()) return localAvg;
    const total = await this.onHand(product.companyId, product.id, undefined, tx);
    const avg = averageCost({ quantityOnHand: total.quantity, totalCost: total.value }, currency);
    if (avg.isPositive()) return avg;
    if (product.standardCost) return Money.of(product.standardCost, currency);
    return Money.of(product.purchasePrice ?? '0', currency);
  }

  // --------------------------------------------------------------- movements

  /** Inbound movement: layer + balance + lot / serials. `unitCost` is required. */
  async receive(tx: DbExecutor, input: MoveStockInput): Promise<MoveStockResult> {
    if (!isInbound(input.movementType)) {
      throw new Error(`receive() called with outbound type ${input.movementType}`);
    }
    if (!input.unitCost) throw new Error('receive() requires a unit cost');
    const currency = input.unitCost.currency;
    const product = await this.resolveProduct(input.companyId, input.productId, tx);
    this.assertStockable(product);
    await this.resolveWarehouse(input.companyId, input.warehouseId, tx);
    const quantity = Money.of(input.quantity, currency);
    if (!quantity.isPositive()) {
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'Quantity must be positive.');
    }
    const lotId = await this.resolveLot(tx, product, input, true);
    const serials = this.expectedSerials(product, input, quantity);
    const totalCost = input.totalCostOverride ?? input.unitCost.multiply(quantity.toString());

    const balance = await this.lockOrCreateBalance(tx, input, lotId);
    const next = applyReceipt(balance, quantity.toString(), totalCost, currency);
    await tx
      .update(inventoryBalances)
      .set({ quantityOnHand: next.quantityOnHand.toString(), totalCost: next.totalCost.toString() })
      .where(eq(inventoryBalances.id, balance.id));

    const [movement] = await tx
      .insert(inventoryMovements)
      .values({
        companyId: input.companyId,
        productId: product.id,
        warehouseId: input.warehouseId,
        locationId: input.locationId ?? null,
        lotId,
        movementType: input.movementType,
        movementDate: input.movementDate,
        quantity: quantity.toString(),
        unitCost: input.unitCost.toString(),
        totalCost: totalCost.toString(),
        balanceAfter: next.quantityOnHand.toString(),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        reversesMovementId: input.reversesMovementId ?? null,
        notes: input.notes ?? null,
        createdBy: input.actorId,
      })
      .returning();
    if (!movement) throw new Error('Insert returned no row');

    const [seq] = await tx
      .select({ n: sql<number>`coalesce(max(${inventoryLayers.sequence}), 0) + 1` })
      .from(inventoryLayers)
      .where(
        and(
          eq(inventoryLayers.productId, product.id),
          eq(inventoryLayers.warehouseId, input.warehouseId),
          eq(inventoryLayers.receivedDate, input.movementDate),
        ),
      );
    await tx.insert(inventoryLayers).values({
      companyId: input.companyId,
      productId: product.id,
      warehouseId: input.warehouseId,
      lotId,
      movementId: movement.id,
      receivedDate: input.movementDate,
      sequence: Number(seq?.n ?? 1),
      quantityReceived: quantity.toString(),
      quantityRemaining: quantity.toString(),
      unitCost: input.unitCost.toString(),
    });
    if (serials) await this.receiveSerials(tx, product, input, lotId, movement.id, serials);
    return { movementId: movement.id, quantity, unitCost: input.unitCost, totalCost, lotId };
  }

  /** Outbound movement valued by the product's costing method (or a forced cost). */
  async issue(
    tx: DbExecutor,
    input: MoveStockInput & { currency: string },
  ): Promise<MoveStockResult> {
    if (isInbound(input.movementType)) {
      throw new Error(`issue() called with inbound type ${input.movementType}`);
    }
    const currency = input.currency;
    const product = await this.resolveProduct(input.companyId, input.productId, tx, {
      allowInactive: true,
    });
    this.assertStockable(product);
    const quantity = Money.of(input.quantity, currency);
    if (!quantity.isPositive()) {
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'Quantity must be positive.');
    }
    const lotId = await this.resolveLot(tx, product, input, false);
    const serials = this.expectedSerials(product, input, quantity);
    const balance = await this.lockOrCreateBalance(tx, input, lotId);
    const fallback = await this.fallbackCost(tx, product, input.warehouseId, currency);

    let totalCost: Money;
    let unitCost: Money;
    if (input.unitCost) {
      // Forced cost (reversal of a receipt): relieve exactly what was received.
      unitCost = input.unitCost;
      totalCost = input.totalCostOverride ?? unitCost.multiply(quantity.toString());
      if (Money.of(balance.quantityOnHand, currency).lessThan(quantity) && !fallback) {
        throw new BusinessRuleError(
          ErrorCodes.INSUFFICIENT_STOCK,
          `Only ${balance.quantityOnHand} available; ${quantity.toString()} requested.`,
          { available: balance.quantityOnHand, requested: quantity.toString() },
        );
      }
      await this.relieveLayers(
        tx,
        product,
        input,
        lotId,
        quantity,
        currency,
        input.preferLayerId ?? null,
      );
    } else if (product.costing === 'FIFO') {
      const layers = await this.openLayers(tx, product.id, input.warehouseId, lotId);
      const result = consumeFifo(layers, quantity.toString(), currency, fallback);
      for (const c of result.consumed) {
        await tx
          .update(inventoryLayers)
          .set({
            quantityRemaining: sql`${inventoryLayers.quantityRemaining} - ${c.quantity.toString()}`,
          })
          .where(eq(inventoryLayers.id, c.layerId));
      }
      totalCost = result.totalCost;
      unitCost = result.unitCost;
    } else {
      const result = issueWeightedAverage(balance, quantity.toString(), currency, fallback);
      totalCost = result.totalCost;
      unitCost = result.unitCost;
      await this.relieveLayers(tx, product, input, lotId, quantity, currency, null);
    }
    // Emptying a balance relieves its exact value so no rounding residue is left behind.
    const afterQty = Money.of(balance.quantityOnHand, currency).subtract(quantity);
    if (
      afterQty.isZero() &&
      Money.of(balance.totalCost, currency).isPositive() &&
      !input.unitCost
    ) {
      totalCost = Money.of(balance.totalCost, currency);
      unitCost = unitCostOf(totalCost, quantity, currency);
    }
    const next = applyIssue(balance, quantity.toString(), totalCost, currency);
    if (next.totalCost.isNegative()) {
      // Negative stock allowed: the value cannot go below zero; the excess is expensed at fallback cost.
      next.totalCost = Money.zero(currency);
    }
    await tx
      .update(inventoryBalances)
      .set({ quantityOnHand: next.quantityOnHand.toString(), totalCost: next.totalCost.toString() })
      .where(eq(inventoryBalances.id, balance.id));

    const [movement] = await tx
      .insert(inventoryMovements)
      .values({
        companyId: input.companyId,
        productId: product.id,
        warehouseId: input.warehouseId,
        locationId: input.locationId ?? null,
        lotId,
        movementType: input.movementType,
        movementDate: input.movementDate,
        quantity: quantity.toString(),
        unitCost: unitCost.toString(),
        totalCost: totalCost.toString(),
        balanceAfter: next.quantityOnHand.toString(),
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        reversesMovementId: input.reversesMovementId ?? null,
        notes: input.notes ?? null,
        createdBy: input.actorId,
      })
      .returning();
    if (!movement) throw new Error('Insert returned no row');
    if (serials) await this.issueSerials(tx, product, input, movement.id, serials);
    return { movementId: movement.id, quantity, unitCost, totalCost, lotId };
  }

  /**
   * Reverses every movement a document recorded (void / cancel): inbound
   * movements are issued back out at their original cost, outbound ones are
   * received back at their original cost. Returns the total value moved back.
   */
  async reverseDocument(
    tx: DbExecutor,
    companyId: string,
    sourceType: MovementSourceType,
    sourceId: string,
    reversalSourceType: MovementSourceType,
    movementDate: string,
    actorId: string,
    currency: string,
  ): Promise<{ movementIds: string[]; byAccount: Map<string, Money> }> {
    const original = await this.movementsOf(tx, sourceType, sourceId);
    const movementIds: string[] = [];
    const byAccount = new Map<string, Money>();
    for (const m of original) {
      const product = await this.resolveProduct(companyId, m.productId, tx, {
        allowInactive: true,
      });
      const serials = await this.serialsOf(tx, m.id);
      const lot = m.lotId
        ? (await tx.select().from(stockLots).where(eq(stockLots.id, m.lotId)))[0]
        : undefined;
      const base = {
        companyId,
        productId: m.productId,
        warehouseId: m.warehouseId,
        locationId: m.locationId,
        quantity: m.quantity,
        movementDate,
        sourceType: reversalSourceType,
        sourceId,
        sourceLineId: m.sourceLineId,
        actorId,
        lotNumber: lot?.lotNumber ?? null,
        serialNumbers: serials,
        reversesMovementId: m.id,
        unitCost: Money.of(m.unitCost, currency),
        totalCostOverride: Money.of(m.totalCost, currency),
      };
      const result = isInbound(m.movementType)
        ? await this.issue(tx, {
            ...base,
            movementType: m.movementType === 'RECEIPT' ? 'RETURN_OUT' : 'ADJUSTMENT_OUT',
            currency,
            preferLayerId: await this.layerOf(tx, m.id),
          })
        : await this.receive(tx, {
            ...base,
            movementType: m.movementType === 'ISSUE' ? 'RETURN_IN' : 'ADJUSTMENT_IN',
          });
      movementIds.push(result.movementId);
      const signed = isInbound(m.movementType) ? result.totalCost.negate() : result.totalCost;
      byAccount.set(
        product.accounts.inventory,
        (byAccount.get(product.accounts.inventory) ?? Money.zero(currency)).add(signed),
      );
    }
    return { movementIds, byAccount };
  }

  // ----------------------------------------------------------------- helpers

  private assertStockable(product: Product): void {
    if (product.productType !== 'GOODS') {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `${product.sku} is a service and does not carry stock.`,
      );
    }
  }

  private async lockOrCreateBalance(
    tx: DbExecutor,
    input: MoveStockInput,
    lotId: string | null,
  ): Promise<InventoryBalance> {
    const existing = await this.balance(tx, input.productId, input.warehouseId, lotId, true);
    if (existing) return existing;
    const [created] = await tx
      .insert(inventoryBalances)
      .values({
        companyId: input.companyId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        lotId,
        quantityOnHand: '0',
        totalCost: '0',
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const row = await this.balance(tx, input.productId, input.warehouseId, lotId, true);
    if (!row) throw new Error('Balance row could not be created');
    return row;
  }

  private async openLayers(
    tx: DbExecutor,
    productId: string,
    warehouseId: string,
    lotId: string | null,
  ) {
    return tx
      .select({
        id: inventoryLayers.id,
        quantityRemaining: inventoryLayers.quantityRemaining,
        unitCost: inventoryLayers.unitCost,
      })
      .from(inventoryLayers)
      .where(
        and(
          eq(inventoryLayers.productId, productId),
          eq(inventoryLayers.warehouseId, warehouseId),
          lotId ? eq(inventoryLayers.lotId, lotId) : isNull(inventoryLayers.lotId),
          sql`${inventoryLayers.quantityRemaining} > 0`,
        ),
      )
      .orderBy(
        asc(inventoryLayers.receivedDate),
        asc(inventoryLayers.sequence),
        asc(inventoryLayers.id),
      )
      .for('update');
  }

  /** Reduce layer quantities (WA and forced-cost issues still keep layers in step for reporting). */
  private async relieveLayers(
    tx: DbExecutor,
    product: Product,
    input: MoveStockInput,
    lotId: string | null,
    quantity: Money,
    currency: string,
    preferLayerId: string | null,
  ): Promise<void> {
    let left = quantity;
    if (preferLayerId) {
      const [layer] = await tx
        .select()
        .from(inventoryLayers)
        .where(eq(inventoryLayers.id, preferLayerId))
        .for('update');
      if (layer) {
        const remaining = Money.of(layer.quantityRemaining, currency);
        const take = remaining.lessThan(left) ? remaining : left;
        if (take.isPositive()) {
          await tx
            .update(inventoryLayers)
            .set({ quantityRemaining: remaining.subtract(take).toString() })
            .where(eq(inventoryLayers.id, layer.id));
          left = left.subtract(take);
        }
      }
    }
    if (!left.isPositive()) return;
    const layers = await this.openLayers(tx, product.id, input.warehouseId, lotId);
    for (const layer of layers) {
      if (!left.isPositive()) break;
      const remaining = Money.of(layer.quantityRemaining, currency);
      const take = remaining.lessThan(left) ? remaining : left;
      await tx
        .update(inventoryLayers)
        .set({ quantityRemaining: remaining.subtract(take).toString() })
        .where(eq(inventoryLayers.id, layer.id));
      left = left.subtract(take);
    }
  }

  private async layerOf(tx: DbExecutor, movementId: string): Promise<string | null> {
    const [layer] = await tx
      .select({ id: inventoryLayers.id })
      .from(inventoryLayers)
      .where(eq(inventoryLayers.movementId, movementId));
    return layer?.id ?? null;
  }

  private async resolveLot(
    tx: DbExecutor,
    product: Product,
    input: StockIdentity & { companyId: string },
    create: boolean,
  ): Promise<string | null> {
    if (product.trackingMode !== 'LOT') return null;
    const lotNumber = input.lotNumber?.trim();
    if (!lotNumber) {
      throw new BusinessRuleError(
        ErrorCodes.STOCK_IDENTITY_REQUIRED,
        `${product.sku} is lot-tracked: a lot number is required.`,
      );
    }
    const [existing] = await tx
      .select()
      .from(stockLots)
      .where(and(eq(stockLots.productId, product.id), eq(stockLots.lotNumber, lotNumber)));
    if (existing) return existing.id;
    if (!create) {
      throw new BusinessRuleError(
        ErrorCodes.STOCK_IDENTITY_REQUIRED,
        `Lot ${lotNumber} of ${product.sku} does not exist.`,
      );
    }
    const [created] = await tx
      .insert(stockLots)
      .values({
        companyId: input.companyId,
        productId: product.id,
        lotNumber,
        expiryDate: input.expiryDate ?? null,
      })
      .returning();
    return created!.id;
  }

  private expectedSerials(
    product: Product,
    input: StockIdentity,
    quantity: Money,
  ): string[] | null {
    if (product.trackingMode !== 'SERIAL') return null;
    const serials = [...new Set((input.serialNumbers ?? []).map((s) => s.trim()).filter(Boolean))];
    if (!quantity.equals(Money.of(String(serials.length), quantity.currency))) {
      throw new BusinessRuleError(
        ErrorCodes.STOCK_IDENTITY_REQUIRED,
        `${product.sku} is serial-tracked: ${quantity.toString()} serial numbers are required (${serials.length} given).`,
      );
    }
    return serials;
  }

  private async receiveSerials(
    tx: DbExecutor,
    product: Product,
    input: MoveStockInput,
    lotId: string | null,
    movementId: string,
    serials: string[],
  ): Promise<void> {
    const existing = await tx
      .select()
      .from(serialNumbers)
      .where(and(eq(serialNumbers.productId, product.id), inArray(serialNumbers.serial, serials)));
    const byserial = new Map(existing.map((s) => [s.serial, s]));
    for (const serial of serials) {
      const row = byserial.get(serial);
      if (row && row.status === 'IN_STOCK') {
        throw new BusinessRuleError(
          ErrorCodes.SERIAL_UNAVAILABLE,
          `Serial ${serial} of ${product.sku} is already in stock.`,
        );
      }
      const [saved] = row
        ? await tx
            .update(serialNumbers)
            .set({
              status: 'IN_STOCK',
              warehouseId: input.warehouseId,
              lotId,
              lastMovementId: movementId,
            })
            .where(eq(serialNumbers.id, row.id))
            .returning({ id: serialNumbers.id })
        : await tx
            .insert(serialNumbers)
            .values({
              companyId: input.companyId,
              productId: product.id,
              serial,
              status: 'IN_STOCK',
              warehouseId: input.warehouseId,
              lotId,
              lastMovementId: movementId,
            })
            .returning({ id: serialNumbers.id });
      await tx.insert(movementSerials).values({ movementId, serialId: saved!.id });
    }
  }

  private async issueSerials(
    tx: DbExecutor,
    product: Product,
    input: MoveStockInput,
    movementId: string,
    serials: string[],
  ): Promise<void> {
    const rows = await tx
      .select()
      .from(serialNumbers)
      .where(and(eq(serialNumbers.productId, product.id), inArray(serialNumbers.serial, serials)))
      .for('update');
    const byserial = new Map(rows.map((s) => [s.serial, s]));
    for (const serial of serials) {
      const row = byserial.get(serial);
      if (!row || row.status !== 'IN_STOCK' || row.warehouseId !== input.warehouseId) {
        throw new BusinessRuleError(
          ErrorCodes.SERIAL_UNAVAILABLE,
          `Serial ${serial} of ${product.sku} is not in stock in this warehouse.`,
        );
      }
      await tx
        .update(serialNumbers)
        .set({ status: 'ISSUED', lastMovementId: movementId })
        .where(eq(serialNumbers.id, row.id));
      await tx.insert(movementSerials).values({ movementId, serialId: row.id });
    }
  }

  private async serialsOf(tx: DbExecutor, movementId: string): Promise<string[]> {
    const rows = await tx
      .select({ serial: serialNumbers.serial })
      .from(movementSerials)
      .innerJoin(serialNumbers, eq(serialNumbers.id, movementSerials.serialId))
      .where(eq(movementSerials.movementId, movementId))
      .orderBy(desc(serialNumbers.serial));
    return rows.map((r) => r.serial);
  }
}
