import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  amountSchema,
  createSalesDocumentSchema,
  isoDateSchema,
  percentSchema,
  quantitySchema,
} from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { customers, products } from '@/database/schema';
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

const ENTITY = 'sales-orders';

/** What a mapping must produce for an external order (e-commerce, POS, CRM, external ERP). */
export const externalSalesOrderSchema = z.object({
  customerExternalId: z.string().min(1).optional(),
  customerCode: z.string().min(1).optional(),
  orderDate: isoDateSchema,
  requestedDate: isoDateSchema.optional(),
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
 * External order -> OrdersService (DRAFT sales order). The order is only
 * submitted when the integration config says `autoSubmit`; approval, credit
 * check, delivery and invoicing then follow the normal order-to-cash flow,
 * so an external system can never post accounting entries.
 */
@Injectable()
export class SalesOrdersImporter implements Importer {
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
    assertScope(ctx, 'sales-order.create');
    const parsed = externalSalesOrderSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const ext = parsed.data;

    const customerId = await this.resolveCustomer(ctx, ext.customerExternalId, ext.customerCode);
    const revenue = await this.accounts.resolveMapped(ctx.companyId, 'SALES_REVENUE');
    const lines = [];
    for (const l of ext.lines) {
      const product = l.productSku ? await this.productBySku(ctx.companyId, l.productSku) : null;
      lines.push({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountPercent: l.discountPercent ?? '0',
        accountId:
          l.accountId ??
          (ctx.integration.config.revenueAccountId as string | undefined) ??
          revenue.id,
        productId: l.productId ?? product?.id ?? null,
        warehouseId: (ctx.integration.config.warehouseId as string | undefined) ?? null,
      });
    }
    const input = createSalesDocumentSchema.safeParse({
      customerId,
      orderDate: ext.orderDate,
      expectedDate: ext.requestedDate ?? null,
      reference: ext.reference ?? record.externalId,
      description: ext.description,
      lines,
      idempotencyKey: domainIdempotencyKey(ctx, ENTITY, record.externalId),
    });
    if (!input.success) throw mappingError(input.error.issues);

    let detail = await this.orders.create(ctx.companyId, ctx.principal, 'SALES_ORDER', input.data);
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
      // Submitting runs the credit policy and opens the approval workflow; never approves.
      detail = await this.orders.transition(
        ctx.companyId,
        ctx.principal,
        'SALES_ORDER',
        detail.id,
        'submit',
      );
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
      'The order does not resolve to a known customer (import customers first or map a customer code).',
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
