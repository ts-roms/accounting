import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  amountSchema,
  createBillSchema,
  isoDateSchema,
  quantitySchema,
} from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { vendors } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { BillsService } from '@/modules/payables/bills.service';
import { VendorsService } from '@/modules/payables/vendors.service';
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

const ENTITY = 'bills';

/** What a mapping must produce for an external supplier invoice. */
export const externalBillSchema = z.object({
  vendorExternalId: z.string().min(1).optional(),
  vendorCode: z.string().min(1).optional(),
  documentDate: isoDateSchema,
  dueDate: isoDateSchema.optional(),
  /** The supplier's own invoice number; defaults to the external id (duplicate detection). */
  vendorInvoiceNumber: z.string().max(60).optional(),
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
 * External supplier invoice -> BillsService (DRAFT). Expense lines default to
 * the mapped account on the line, then the integration's `expenseAccountId`,
 * then the vendor's default expense account, then the DEFAULT_EXPENSE
 * mapping. The bill is only approved and posted when the integration holds
 * `bills:post` **and** its config says `autoPost`; the ledger effect then
 * comes from BillsService.post, i.e. AccountingPostingService, exactly as
 * for a bill keyed in by hand (delegated authority checks included).
 */
@Injectable()
export class BillsImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly bills: BillsService,
    private readonly vendors: VendorsService,
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
    assertScope(ctx, 'bill.create');
    const parsed = externalBillSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const ext = parsed.data;

    const vendorId = await this.resolveVendor(ctx, ext.vendorExternalId, ext.vendorCode);
    const vendor = await this.vendors.getOrThrow(ctx.companyId, vendorId);
    const configured = ctx.integration.config.expenseAccountId as string | undefined;
    const fallback =
      configured ??
      vendor.defaultExpenseAccountId ??
      (await this.accounts.resolveMapped(ctx.companyId, 'DEFAULT_EXPENSE')).id;
    const input = createBillSchema.safeParse({
      documentType: 'INVOICE',
      vendorId,
      documentDate: ext.documentDate,
      dueDate: ext.dueDate,
      vendorInvoiceNumber: ext.vendorInvoiceNumber ?? record.externalId,
      reference: ext.reference ?? record.externalId,
      description: ext.description,
      lines: ext.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        accountId: l.accountId ?? fallback,
        taxCodeId: l.taxCodeId,
      })),
      idempotencyKey: domainIdempotencyKey(ctx, ENTITY, record.externalId),
    });
    if (!input.success) throw mappingError(input.error.issues);

    let detail = await this.bills.create(ctx.companyId, ctx.principal, input.data);
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
      // Explicit scope: without bills:post the importer stops at DRAFT and says so.
      assertScope(ctx, 'bill.approve', 'bill.post');
      detail = await this.bills.approve(ctx.companyId, ctx.principal, detail.id);
      detail = await this.bills.post(ctx.companyId, ctx.principal, detail.id);
    }
    return { action: 'CREATED', internalId: detail.id, documentNumber: detail.documentNumber };
  }

  private async resolveVendor(
    ctx: ImportContext,
    externalId?: string,
    code?: string,
  ): Promise<string> {
    if (externalId) {
      const ref = await this.refs.findByExternal(ctx.integration.id, 'vendors', externalId);
      if (ref) return ref.internalId;
    }
    if (code) {
      const [row] = await this.db
        .select({ id: vendors.id })
        .from(vendors)
        .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.code, code)));
      if (row) return row.id;
    }
    throw new IntegrationError(
      'MAPPING_ERROR',
      'The vendor of this document has not been imported yet.',
      {
        details: { vendorExternalId: externalId ?? null, vendorCode: code ?? null },
      },
    );
  }
}
