import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createProductSchema, updateProductSchema } from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { products } from '@/database/schema';
import { CatalogService } from '@/modules/inventory/catalog.service';
import type { ExternalRecord } from '../../core/connector';
import { ExternalReferencesService } from '../../mapping/external-references.service';
import { mappingError } from './customers.importer';
import { assertScope, type ImportContext, type ImportOutcome, type Importer } from './importer';

const ENTITY = 'products';

/**
 * External catalogue item -> CatalogService. Matching order: external
 * reference, then SKU (case-insensitive, the catalogue stores SKUs upper
 * case). Only the catalogue record is touched: stock never moves through an
 * import, so quantities on the external record are ignored by design.
 */
@Injectable()
export class ProductsImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly catalog: CatalogService,
    private readonly refs: ExternalReferencesService,
  ) {}

  async import(
    ctx: ImportContext,
    record: ExternalRecord,
    mapped: Record<string, unknown>,
  ): Promise<ImportOutcome> {
    assertScope(ctx, 'product.manage');
    const existingRef = await this.refs.findByExternal(
      ctx.integration.id,
      ENTITY,
      record.externalId,
    );
    if (existingRef) {
      const parsed = updateProductSchema.safeParse(mapped);
      if (!parsed.success) throw mappingError(parsed.error.issues);
      const { sku: _sku, ...changes } = parsed.data;
      const view = await this.catalog.updateProduct(
        ctx.companyId,
        ctx.principal,
        existingRef.internalId,
        changes,
      );
      await this.link(ctx, record, view.id);
      return { action: 'UPDATED', internalId: view.id };
    }

    const parsed = createProductSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const [bySku] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(
        and(eq(products.companyId, ctx.companyId), eq(products.sku, parsed.data.sku.toUpperCase())),
      );
    let internalId: string;
    let action: ImportOutcome['action'];
    if (bySku) {
      const { sku: _sku, ...changes } = parsed.data;
      await this.catalog.updateProduct(ctx.companyId, ctx.principal, bySku.id, changes);
      internalId = bySku.id;
      action = 'UPDATED';
    } else {
      const view = await this.catalog.createProduct(ctx.companyId, ctx.principal, parsed.data);
      internalId = view.id;
      action = 'CREATED';
    }
    await this.link(ctx, record, internalId);
    return { action, internalId };
  }

  private link(ctx: ImportContext, record: ExternalRecord, internalId: string): Promise<unknown> {
    return this.db.transaction((tx) =>
      this.refs.link(tx, {
        integrationId: ctx.integration.id,
        provider: ctx.provider,
        entityType: ENTITY,
        externalId: record.externalId,
        internalId,
        metadata: { updatedAt: record.updatedAt ?? null },
      }),
    );
  }
}
