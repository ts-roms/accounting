import { Injectable } from '@nestjs/common';
import { createCustomerSchema, updateCustomerSchema } from '@accounting/validation';
import { CustomersService } from '@/modules/receivables/customers.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { customers } from '@/database/schema';
import type { ExternalRecord } from '../../core/connector';
import { IntegrationError } from '../../core/integration-error';
import { ExternalReferencesService } from '../../mapping/external-references.service';
import { assertScope, type ImportContext, type ImportOutcome, type Importer } from './importer';

const ENTITY = 'customers';

/**
 * External customer -> CustomersService. Matching order: external reference,
 * then customer code (so a re-connected provider adopts existing records
 * instead of duplicating them).
 */
@Injectable()
export class CustomersImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly customers: CustomersService,
    private readonly refs: ExternalReferencesService,
  ) {}

  async import(
    ctx: ImportContext,
    record: ExternalRecord,
    mapped: Record<string, unknown>,
  ): Promise<ImportOutcome> {
    const existingRef = await this.refs.findByExternal(
      ctx.integration.id,
      ENTITY,
      record.externalId,
    );
    if (existingRef) {
      assertScope(ctx, 'customer.manage');
      const parsed = updateCustomerSchema.safeParse(mapped);
      if (!parsed.success) throw mappingError(parsed.error.issues);
      const { code: _code, ...changes } = parsed.data;
      const view = await this.customers.update(ctx.companyId, existingRef.internalId, changes);
      await this.db.transaction((tx) =>
        this.refs.link(tx, {
          integrationId: ctx.integration.id,
          provider: ctx.provider,
          entityType: ENTITY,
          externalId: record.externalId,
          internalId: view.id,
          metadata: { updatedAt: record.updatedAt ?? null },
        }),
      );
      return { action: 'UPDATED', internalId: view.id };
    }

    assertScope(ctx, 'customer.manage');
    const parsed = createCustomerSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const [byCode] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), eq(customers.code, parsed.data.code)));
    let internalId: string;
    let action: ImportOutcome['action'];
    if (byCode) {
      const { code: _code, ...changes } = parsed.data;
      await this.customers.update(ctx.companyId, byCode.id, changes);
      internalId = byCode.id;
      action = 'UPDATED';
    } else {
      const view = await this.customers.create(ctx.companyId, parsed.data);
      internalId = view.id;
      action = 'CREATED';
    }
    await this.db.transaction((tx) =>
      this.refs.link(tx, {
        integrationId: ctx.integration.id,
        provider: ctx.provider,
        entityType: ENTITY,
        externalId: record.externalId,
        internalId,
        metadata: { updatedAt: record.updatedAt ?? null },
      }),
    );
    return { action, internalId };
  }
}

export function mappingError(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): IntegrationError {
  return new IntegrationError('VALIDATION_ERROR', 'The mapped record failed domain validation.', {
    details: { issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
  });
}
