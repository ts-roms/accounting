import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createInvoiceSchema,
  isoDateSchema,
  amountSchema,
  quantitySchema,
} from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { customers } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { InvoicesService } from '@/modules/receivables/invoices.service';
import type { ExternalRecord } from '../../core/connector';
import { IntegrationError } from '../../core/integration-error';
import { ExternalReferencesService } from '../../mapping/external-references.service';
import { mappingError } from './customers.importer';
import {
  assertScope,
  domainIdempotencyKey,
  type ImportContext,
  type ImportOutcome,
  type Importer,
} from './importer';

const ENTITY = 'invoices';

/** What a mapping must produce for an external order / invoice. */
export const externalInvoiceSchema = z.object({
  customerExternalId: z.string().min(1).optional(),
  customerCode: z.string().min(1).optional(),
  documentDate: isoDateSchema,
  dueDate: isoDateSchema.optional(),
  reference: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  currency: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        quantity: quantitySchema.default('1'),
        unitPrice: amountSchema,
        accountId: z.string().uuid().optional(),
        taxCodeId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});

/**
 * External sale -> InvoicesService (DRAFT). The invoice is only approved and
 * posted when the integration was granted `invoices:post` **and** its config
 * says `autoPost`; the ledger effect then comes from InvoicesService.post,
 * i.e. AccountingPostingService, exactly as for a manual invoice.
 */
@Injectable()
export class InvoicesImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly invoices: InvoicesService,
    private readonly accounts: AccountsService,
    private readonly refs: ExternalReferencesService,
  ) {}

  async import(
    ctx: ImportContext,
    record: ExternalRecord,
    mapped: Record<string, unknown>,
  ): Promise<ImportOutcome> {
    const existing = await this.refs.findByExternal(ctx.integration.id, ENTITY, record.externalId);
    if (existing)
      return { action: 'SKIPPED', internalId: existing.internalId, message: 'already imported' };
    assertScope(ctx, 'invoice.create');
    const parsed = externalInvoiceSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const ext = parsed.data;

    const customerId = await this.resolveCustomer(ctx, ext.customerExternalId, ext.customerCode);
    const revenue = await this.accounts.resolveMapped(ctx.companyId, 'SALES_REVENUE');
    const input = createInvoiceSchema.safeParse({
      documentType: 'INVOICE',
      customerId,
      documentDate: ext.documentDate,
      dueDate: ext.dueDate,
      reference: ext.reference ?? record.externalId,
      description: ext.description,
      lines: ext.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        accountId:
          l.accountId ??
          (ctx.integration.config.revenueAccountId as string | undefined) ??
          revenue.id,
        taxCodeId: l.taxCodeId,
      })),
      idempotencyKey: domainIdempotencyKey(ctx, ENTITY, record.externalId),
    });
    if (!input.success) throw mappingError(input.error.issues);

    let detail = await this.invoices.create(ctx.companyId, ctx.principal, input.data);
    await this.db.transaction((tx) =>
      this.refs.link(tx, {
        integrationId: ctx.integration.id,
        provider: ctx.provider,
        entityType: ENTITY,
        externalId: record.externalId,
        internalId: detail.id,
        metadata: { documentNumber: detail.documentNumber },
      }),
    );
    if (ctx.integration.config.autoPost === true) {
      // Explicit scope: without invoices:post the importer stops at DRAFT and says so.
      assertScope(ctx, 'invoice.approve', 'invoice.post');
      detail = await this.invoices.approve(ctx.companyId, ctx.principal, detail.id);
      detail = await this.invoices.post(ctx.companyId, ctx.principal, detail.id);
    }
    return { action: 'CREATED', internalId: detail.id, documentNumber: detail.documentNumber };
  }

  private async resolveCustomer(
    ctx: ImportContext,
    externalId?: string,
    code?: string,
  ): Promise<string> {
    if (externalId) {
      const ref = await this.refs.findByExternal(ctx.integration.id, 'customers', externalId);
      if (ref) return ref.internalId;
    }
    if (code) {
      const [row] = await this.db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), eq(customers.code, code)));
      if (row) return row.id;
    }
    throw new IntegrationError(
      'MAPPING_ERROR',
      'The customer of this document has not been imported yet.',
      {
        details: { customerExternalId: externalId ?? null, customerCode: code ?? null },
      },
    );
  }
}
