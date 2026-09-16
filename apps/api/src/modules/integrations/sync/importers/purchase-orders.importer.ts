import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  amountSchema,
  createPurchaseOrderSchema,
  isoDateSchema,
  percentSchema,
  quantitySchema,
} from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { products, vendors } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { OrdersService } from '@/modules/orders/orders.service';
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

const ENTITY = 'purchase-orders';

/** What a mapping must produce for an external purchase order (procurement portal, external ERP, punch-out). */
export const externalPurchaseOrderSchema = z.object({
  vendorExternalId: z.string().min(1).optional(),
  vendorCode: z.string().min(1).optional(),
  orderDate: isoDateSchema,
  expectedDate: isoDateSchema.optional(),
  reference: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        quantity: quantitySchema.default('1'),
        unitPrice: amountSchema,
        discountPercent: percentSchema.optional(),
        accountId: z.string().uuid().optional(),
        productSku: z.string().max(60).optional(),
        productId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});

/**
 * External purchase order -> OrdersService (DRAFT purchase order). The order
 * is only submitted when the integration config says `autoSubmit`; approval,
 * receiving and billing then follow the normal procure-to-pay flow, so an
 * external system can never post accounting entries or pay anyone.
 */
@Injectable()
export class PurchaseOrdersImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly orders: OrdersService,
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
    assertScope(ctx, 'purchase-order.create');
    const parsed = externalPurchaseOrderSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const ext = parsed.data;

    const vendor = await this.resolveVendor(ctx, ext.vendorExternalId, ext.vendorCode);
    const configured = ctx.integration.config.expenseAccountId as string | undefined;
    const fallback =
      configured ??
      vendor.defaultExpenseAccountId ??
      (await this.accounts.resolveMapped(ctx.companyId, 'DEFAULT_EXPENSE')).id;
    const lines = [];
    for (const l of ext.lines) {
      const product = l.productSku ? await this.productBySku(ctx.companyId, l.productSku) : null;
      lines.push({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountPercent: l.discountPercent ?? '0',
        accountId: l.accountId ?? fallback,
        productId: l.productId ?? product?.id ?? null,
        warehouseId: (ctx.integration.config.warehouseId as string | undefined) ?? null,
      });
    }
    const input = createPurchaseOrderSchema.safeParse({
      vendorId: vendor.id,
      orderDate: ext.orderDate,
      expectedDate: ext.expectedDate ?? null,
      reference: ext.reference ?? record.externalId,
      description: ext.description,
      lines,
      idempotencyKey: domainIdempotencyKey(ctx, ENTITY, record.externalId),
    });
    if (!input.success) throw mappingError(input.error.issues);

    let detail = await this.orders.create(
      ctx.companyId,
      ctx.principal,
      'PURCHASE_ORDER',
      input.data,
    );
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
    if (ctx.integration.config.autoSubmit === true) {
      // Submitting checks the vendor and opens the approval workflow; never approves.
      detail = await this.orders.transition(
        ctx.companyId,
        ctx.principal,
        'PURCHASE_ORDER',
        detail.id,
        'submit',
      );
    }
    return { action: 'CREATED', internalId: detail.id, documentNumber: detail.documentNumber };
  }

  private async resolveVendor(
    ctx: ImportContext,
    externalId?: string,
    code?: string,
  ): Promise<{ id: string; defaultExpenseAccountId: string | null }> {
    const cols = { id: vendors.id, defaultExpenseAccountId: vendors.defaultExpenseAccountId };
    if (externalId) {
      const ref = await this.refs.findByExternal(ctx.integration.id, 'vendors', externalId);
      if (ref) {
        const [row] = await this.db
          .select(cols)
          .from(vendors)
          .where(eq(vendors.id, ref.internalId));
        if (row) return row;
      }
    }
    if (code) {
      const [row] = await this.db
        .select(cols)
        .from(vendors)
        .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.code, code)));
      if (row) return row;
    }
    throw new IntegrationError(
      'MAPPING_ERROR',
      'The purchase order does not resolve to a known vendor (import vendors first or map a vendor code).',
      { details: { externalId, code } },
    );
  }

  private async productBySku(companyId: string, sku: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.sku, sku)));
    return row ?? null;
  }
}
