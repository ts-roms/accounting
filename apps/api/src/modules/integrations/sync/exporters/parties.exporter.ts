import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/database/database.types';
import { customers, products, vendors } from '@/database/schema';
import { CatalogService } from '@/modules/inventory/catalog.service';
import { VendorsService } from '@/modules/payables/vendors.service';
import { CustomersService } from '@/modules/receivables/customers.service';
import { assertScope } from '../importers/importer';
import type { ExportContext, ExportPage, ExportQuery, ExportRecord, Exporter } from './exporter';
import { selectKeyset } from './keyset';

/**
 * Master-data exporters: every customer / vendor / product of the company in
 * (updatedAt, id) order, payload = the API view. Inactive records are exported
 * too (with their status) so a provider can retire them; nothing is filtered
 * silently.
 */
@Injectable()
export class CustomersExporter implements Exporter {
  readonly entity = 'customers' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly customers: CustomersService,
  ) {}

  async select(ctx: ExportContext, query: ExportQuery): Promise<ExportPage> {
    assertScope(ctx, 'customer.view');
    const { ids, hasMore } = await selectKeyset(
      this.db,
      customers,
      { id: customers.id, updatedAt: customers.updatedAt },
      [eq(customers.companyId, ctx.companyId)],
      query.after,
      query.limit,
    );
    const records = [];
    for (const row of ids) {
      const view = await this.customers.getView(ctx.companyId, row.id);
      records.push({
        internalId: row.id,
        updatedAt: row.updatedAt,
        label: view.code,
        data: { ...view } as Record<string, unknown>,
      });
    }
    return { records, hasMore };
  }

  async byId(ctx: ExportContext, internalId: string): Promise<ExportRecord | null> {
    assertScope(ctx, 'customer.view');
    const [row] = await this.db
      .select({ id: customers.id, updatedAt: customers.updatedAt })
      .from(customers)
      .where(and(eq(customers.id, internalId), eq(customers.companyId, ctx.companyId)));
    if (!row) return null;
    const view = await this.customers.getView(ctx.companyId, row.id);
    return {
      internalId: row.id,
      updatedAt: row.updatedAt,
      label: view.code,
      data: { ...view } as Record<string, unknown>,
    };
  }
}

@Injectable()
export class VendorsExporter implements Exporter {
  readonly entity = 'vendors' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly vendors: VendorsService,
  ) {}

  async select(ctx: ExportContext, query: ExportQuery): Promise<ExportPage> {
    assertScope(ctx, 'vendor.view');
    const { ids, hasMore } = await selectKeyset(
      this.db,
      vendors,
      { id: vendors.id, updatedAt: vendors.updatedAt },
      [eq(vendors.companyId, ctx.companyId)],
      query.after,
      query.limit,
    );
    const records = [];
    for (const row of ids) {
      const view = await this.vendors.getView(ctx.companyId, row.id);
      records.push({
        internalId: row.id,
        updatedAt: row.updatedAt,
        label: view.code,
        data: { ...view } as Record<string, unknown>,
      });
    }
    return { records, hasMore };
  }

  async byId(ctx: ExportContext, internalId: string): Promise<ExportRecord | null> {
    assertScope(ctx, 'vendor.view');
    const [row] = await this.db
      .select({ id: vendors.id, updatedAt: vendors.updatedAt })
      .from(vendors)
      .where(and(eq(vendors.id, internalId), eq(vendors.companyId, ctx.companyId)));
    if (!row) return null;
    const view = await this.vendors.getView(ctx.companyId, row.id);
    return {
      internalId: row.id,
      updatedAt: row.updatedAt,
      label: view.code,
      data: { ...view } as Record<string, unknown>,
    };
  }
}

@Injectable()
export class ProductsExporter implements Exporter {
  readonly entity = 'products' as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalog: CatalogService,
  ) {}

  async select(ctx: ExportContext, query: ExportQuery): Promise<ExportPage> {
    assertScope(ctx, 'product.view');
    const { ids, hasMore } = await selectKeyset(
      this.db,
      products,
      { id: products.id, updatedAt: products.updatedAt },
      [eq(products.companyId, ctx.companyId)],
      query.after,
      query.limit,
    );
    const records = [];
    for (const row of ids) {
      const view = await this.catalog.getProduct(ctx.companyId, row.id);
      records.push({
        internalId: row.id,
        updatedAt: row.updatedAt,
        label: view.sku,
        data: { ...view } as Record<string, unknown>,
      });
    }
    return { records, hasMore };
  }

  async byId(ctx: ExportContext, internalId: string): Promise<ExportRecord | null> {
    assertScope(ctx, 'product.view');
    const [row] = await this.db
      .select({ id: products.id, updatedAt: products.updatedAt })
      .from(products)
      .where(and(eq(products.id, internalId), eq(products.companyId, ctx.companyId)));
    if (!row) return null;
    const view = await this.catalog.getProduct(ctx.companyId, row.id);
    return {
      internalId: row.id,
      updatedAt: row.updatedAt,
      label: view.sku,
      data: { ...view } as Record<string, unknown>,
    };
  }
}
