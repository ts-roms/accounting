import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { PaginatedResult } from '@accounting/types';
import type {
  CreateLocationInput,
  CreateProductCategoryInput,
  CreateProductInput,
  CreateWarehouseInput,
  ListProductsQuery,
  UpdateProductCategoryInput,
  UpdateProductInput,
  UpdateWarehouseInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  inventoryBalances,
  productCategories,
  products,
  warehouseLocations,
  warehouses,
  type Product,
  type ProductCategory,
  type Warehouse,
  type WarehouseLocation,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';

const MODULE = 'INVENTORY';

export interface ProductView extends Product {
  categoryName: string | null;
  quantityOnHand: string;
  stockValue: string;
}

/** Products, categories, warehouses and locations - inventory master data. */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly outbox: OutboxService,
  ) {}

  // ---------------------------------------------------------------- products

  async listProducts(
    companyId: string,
    query: ListProductsQuery,
  ): Promise<PaginatedResult<ProductView>> {
    const filters: SQL[] = [eq(products.companyId, companyId)];
    if (query.status) filters.push(eq(products.status, query.status));
    if (query.productType) filters.push(eq(products.productType, query.productType));
    if (query.categoryId) filters.push(eq(products.categoryId, query.categoryId));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(ilike(products.sku, term), ilike(products.name, term), ilike(products.barcode, term))!,
      );
    }
    const onHand = sql<string>`coalesce((select sum(b.quantity_on_hand) from inventory_balances b where b.product_id = ${products.id}), 0)`;
    const value = sql<string>`coalesce((select sum(b.total_cost) from inventory_balances b where b.product_id = ${products.id}), 0)`;
    if (query.belowReorder) {
      filters.push(
        sql`${products.reorderLevel} IS NOT NULL AND ${onHand} <= ${products.reorderLevel}`,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'name'
        ? products.name
        : query.sortBy === 'sku'
          ? products.sku
          : products.name;
    const direction = query.sortDir === 'desc' ? desc : asc;
    const [rows, countRows] = await Promise.all([
      this.db
        .select({
          ...getTableColumns(products),
          categoryName: productCategories.name,
          quantityOnHand: onHand,
          stockValue: value,
        })
        .from(products)
        .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
        .where(where)
        .orderBy(direction(sortColumn), asc(products.sku))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(products)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async getProduct(companyId: string, id: string): Promise<ProductView> {
    const [row] = await this.db
      .select({
        ...getTableColumns(products),
        categoryName: productCategories.name,
        quantityOnHand: sql<string>`coalesce((select sum(b.quantity_on_hand) from inventory_balances b where b.product_id = ${products.id}), 0)`,
        stockValue: sql<string>`coalesce((select sum(b.total_cost) from inventory_balances b where b.product_id = ${products.id}), 0)`,
      })
      .from(products)
      .leftJoin(productCategories, eq(productCategories.id, products.categoryId))
      .where(and(eq(products.id, id), eq(products.companyId, companyId)));
    if (!row) throw new NotFoundError('Product', id);
    return row;
  }

  async createProduct(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateProductInput,
  ): Promise<ProductView> {
    const id = await this.db.transaction(async (tx) => {
      await this.assertAccounts(companyId, input, tx);
      if (input.categoryId) await this.getCategory(companyId, input.categoryId, tx);
      let created: Product | undefined;
      try {
        [created] = await tx
          .insert(products)
          .values({ companyId, ...input, sku: input.sku.toUpperCase() })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'products_company_sku_uq'))
          throw new DuplicateError('Product', 'sku', input.sku);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Product',
          entityId: created!.id,
          newValue: { sku: created!.sku, name: created!.name },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'product.created',
        companyId,
        dedupeKey: 'product.created:' + created!.id,
        payload: {
          productId: created!.id,
          sku: created!.sku,
          name: created!.name,
          productType: created!.productType,
          status: created!.status,
        },
      });
      return created!.id;
    });
    return this.getProduct(companyId, id);
  }

  async updateProduct(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateProductInput,
  ): Promise<ProductView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, id), eq(products.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Product', id);
      await this.assertAccounts(companyId, input, tx);
      if (input.categoryId) await this.getCategory(companyId, input.categoryId, tx);
      // Changing what a product is (goods <-> service, tracking, costing) after stock exists would corrupt valuation.
      const [stock] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(inventoryBalances)
        .where(
          and(eq(inventoryBalances.productId, id), sql`${inventoryBalances.quantityOnHand} <> 0`),
        );
      const hasStock = Number(stock?.n ?? 0) > 0;
      if (hasStock) {
        for (const field of ['productType', 'trackingMode', 'costingMethod'] as const) {
          if (input[field] !== undefined && input[field] !== existing[field]) {
            throw new BusinessRuleError(
              ErrorCodes.DOCUMENT_INVALID_STATE,
              `${field} cannot change while ${existing.sku} has stock on hand.`,
            );
          }
        }
      }
      const { sku, ...rest } = input;
      await tx
        .update(products)
        .set({ ...rest, ...(sku ? { sku: sku.toUpperCase() } : {}) })
        .where(eq(products.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Product',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status },
          newValue: input,
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'product.updated',
        companyId,
        payload: {
          productId: id,
          sku: sku ? sku.toUpperCase() : existing.sku,
          name: input.name ?? existing.name,
          status: input.status ?? existing.status,
          changed: Object.keys(rest),
        },
      });
    });
    return this.getProduct(companyId, id);
  }

  // -------------------------------------------------------------- categories

  async listCategories(
    companyId: string,
  ): Promise<Array<ProductCategory & { productCount: number }>> {
    return this.db
      .select({
        ...getTableColumns(productCategories),
        productCount: sql<number>`(select count(*)::int from products p where p.category_id = ${productCategories.id})`,
      })
      .from(productCategories)
      .where(eq(productCategories.companyId, companyId))
      .orderBy(asc(productCategories.code));
  }

  async getCategory(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<ProductCategory> {
    const [row] = await executor
      .select()
      .from(productCategories)
      .where(and(eq(productCategories.id, id), eq(productCategories.companyId, companyId)));
    if (!row) throw new NotFoundError('Product category', id);
    return row;
  }

  async createCategory(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateProductCategoryInput,
  ): Promise<ProductCategory> {
    return this.db.transaction(async (tx) => {
      await this.assertAccounts(companyId, input, tx);
      let created: ProductCategory | undefined;
      try {
        [created] = await tx
          .insert(productCategories)
          .values({ companyId, ...input, code: input.code.toUpperCase() })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'product_categories_company_code_uq'))
          throw new DuplicateError('Product category', 'code', input.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ProductCategory',
          entityId: created!.id,
          newValue: { code: created!.code },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updateCategory(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateProductCategoryInput,
  ): Promise<ProductCategory> {
    return this.db.transaction(async (tx) => {
      await this.getCategory(companyId, id, tx);
      await this.assertAccounts(companyId, input, tx);
      const { code, ...rest } = input;
      const [row] = await tx
        .update(productCategories)
        .set({ ...rest, ...(code ? { code: code.toUpperCase() } : {}) })
        .where(eq(productCategories.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ProductCategory',
          entityId: id,
          newValue: input,
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  // -------------------------------------------------------------- warehouses

  async listWarehouses(
    companyId: string,
  ): Promise<Array<Warehouse & { locations: WarehouseLocation[]; stockValue: string }>> {
    const rows = await this.db
      .select({
        ...getTableColumns(warehouses),
        stockValue: sql<string>`coalesce((select sum(b.total_cost) from inventory_balances b where b.warehouse_id = ${warehouses.id}), 0)`,
      })
      .from(warehouses)
      .where(eq(warehouses.companyId, companyId))
      .orderBy(asc(warehouses.code));
    const locations = rows.length
      ? await this.db
          .select()
          .from(warehouseLocations)
          .where(sql`${warehouseLocations.warehouseId} in ${rows.map((r) => r.id)}`)
          .orderBy(asc(warehouseLocations.code))
      : [];
    return rows.map((w) => ({ ...w, locations: locations.filter((l) => l.warehouseId === w.id) }));
  }

  async createWarehouse(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateWarehouseInput,
  ): Promise<Warehouse> {
    return this.db.transaction(async (tx) => {
      let created: Warehouse | undefined;
      try {
        [created] = await tx
          .insert(warehouses)
          .values({ companyId, ...input, code: input.code.toUpperCase() })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'warehouses_company_code_uq'))
          throw new DuplicateError('Warehouse', 'code', input.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Warehouse',
          entityId: created!.id,
          newValue: { code: created!.code, name: created!.name },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updateWarehouse(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateWarehouseInput,
  ): Promise<Warehouse> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(warehouses)
        .where(and(eq(warehouses.id, id), eq(warehouses.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Warehouse', id);
      if (input.status === 'INACTIVE') {
        const [stock] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(inventoryBalances)
          .where(
            and(
              eq(inventoryBalances.warehouseId, id),
              sql`${inventoryBalances.quantityOnHand} <> 0`,
            ),
          );
        if (Number(stock?.n ?? 0) > 0)
          throw new BusinessRuleError(
            ErrorCodes.DOCUMENT_INVALID_STATE,
            `${existing.code} still holds stock; transfer it out before deactivating.`,
          );
      }
      const { code, ...rest } = input;
      const [row] = await tx
        .update(warehouses)
        .set({ ...rest, ...(code ? { code: code.toUpperCase() } : {}) })
        .where(eq(warehouses.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Warehouse',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status },
          newValue: input,
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async addLocation(
    companyId: string,
    warehouseId: string,
    input: CreateLocationInput,
  ): Promise<WarehouseLocation> {
    const [wh] = await this.db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.id, warehouseId), eq(warehouses.companyId, companyId)));
    if (!wh) throw new NotFoundError('Warehouse', warehouseId);
    try {
      const [row] = await this.db
        .insert(warehouseLocations)
        .values({ warehouseId, ...input, code: input.code.toUpperCase() })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err, 'warehouse_locations_code_uq'))
        throw new DuplicateError('Location', 'code', input.code);
      throw err;
    }
  }

  // ----------------------------------------------------------------- helpers

  private async assertAccounts(
    companyId: string,
    input: {
      inventoryAccountId?: string | null;
      cogsAccountId?: string | null;
      revenueAccountId?: string | null;
      expenseAccountId?: string | null;
    },
    tx: DbExecutor,
  ): Promise<void> {
    const ids = [
      input.inventoryAccountId,
      input.cogsAccountId,
      input.revenueAccountId,
      input.expenseAccountId,
    ].filter((x): x is string => Boolean(x));
    if (ids.length === 0) return;
    const rows = await this.accounts.findByIds(companyId, [...new Set(ids)], tx);
    const byId = new Map(rows.map((a) => [a.id, a]));
    for (const id of ids) {
      const account = byId.get(id);
      if (!account)
        throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'An account override does not exist.');
      if (account.isHeader || account.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} ${account.name} cannot be used for postings.`,
        );
    }
  }
}
