import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createVendorSchema, updateVendorSchema } from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { vendors } from '@/database/schema';
import { VendorsService } from '@/modules/payables/vendors.service';
import type { ExternalRecord } from '../../core/connector';
import { ExternalReferencesService } from '../../mapping/external-references.service';
import { mappingError } from './customers.importer';
import { assertScope, type ImportContext, type ImportOutcome, type Importer } from './importer';

const ENTITY = 'vendors';

/**
 * External supplier -> VendorsService. Same matching order as customers:
 * external reference first, then vendor code, so a re-connected provider
 * adopts the vendors that already exist instead of duplicating them.
 */
@Injectable()
export class VendorsImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly vendors: VendorsService,
    private readonly refs: ExternalReferencesService,
  ) {}

  async import(
    ctx: ImportContext,
    record: ExternalRecord,
    mapped: Record<string, unknown>,
  ): Promise<ImportOutcome> {
    assertScope(ctx, 'vendor.manage');
    const existingRef = await this.refs.findByExternal(
      ctx.integration.id,
      ENTITY,
      record.externalId,
    );
    if (existingRef) {
      const parsed = updateVendorSchema.safeParse(mapped);
      if (!parsed.success) throw mappingError(parsed.error.issues);
      const { code: _code, ...changes } = parsed.data;
      const view = await this.vendors.update(ctx.companyId, existingRef.internalId, changes);
      await this.link(ctx, record, view.id);
      return { action: 'UPDATED', internalId: view.id };
    }

    const parsed = createVendorSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const [byCode] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.code, parsed.data.code)));
    let internalId: string;
    let action: ImportOutcome['action'];
    if (byCode) {
      const { code: _code, ...changes } = parsed.data;
      await this.vendors.update(ctx.companyId, byCode.id, changes);
      internalId = byCode.id;
      action = 'UPDATED';
    } else {
      const view = await this.vendors.create(ctx.companyId, parsed.data);
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
