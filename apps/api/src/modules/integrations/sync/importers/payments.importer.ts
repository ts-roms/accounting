import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Money } from '@accounting/money';
import { PAYMENT_METHODS } from '@accounting/types';
import { amountSchema, createPaymentSchema, isoDateSchema } from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { customers, invoices } from '@/database/schema';
import { CustomerPaymentsService } from '@/modules/receivables/customer-payments.service';
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

const ENTITY = 'payments';

export const externalPaymentSchema = z.object({
  customerExternalId: z.string().min(1).optional(),
  customerCode: z.string().min(1).optional(),
  /** External id of the invoice / order the money settles (allocated when it is posted and open). */
  invoiceExternalId: z.string().min(1).optional(),
  paymentDate: isoDateSchema,
  amount: amountSchema,
  currency: z.string().length(3).optional(),
  method: z.enum(PAYMENT_METHODS).default('BANK_TRANSFER'),
  reference: z.string().max(100).optional(),
  memo: z.string().max(500).optional(),
  /** Provider status; only settled money becomes a receipt. */
  status: z.string().optional(),
});

/**
 * External payment (gateway payout, marketplace settlement) -> customer
 * receipt through CustomerPaymentsService. Money lands in the account the
 * integration is configured with (`cashAccountId`); posting - the only step
 * that touches the ledger - happens through CustomerPaymentsService.post and
 * therefore AccountingPostingService, and only with `payments:post`.
 */
@Injectable()
export class PaymentsImporter implements Importer {
  readonly entity = ENTITY;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly payments: CustomerPaymentsService,
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
    assertScope(ctx, 'customer-payment.create');
    const parsed = externalPaymentSchema.safeParse(mapped);
    if (!parsed.success) throw mappingError(parsed.error.issues);
    const ext = parsed.data;
    if (
      ext.status &&
      !['PAID', 'SETTLED', 'SUCCEEDED', 'COMPLETED', 'CAPTURED'].includes(ext.status.toUpperCase())
    )
      return { action: 'SKIPPED', message: `status ${ext.status} is not settled` };

    const cashAccountId = ctx.integration.config.cashAccountId;
    if (typeof cashAccountId !== 'string')
      throw new IntegrationError(
        'VALIDATION_ERROR',
        'The integration has no cashAccountId configured.',
      );

    const customerId = await this.resolveCustomer(ctx, ext.customerExternalId, ext.customerCode);
    const allocations = await this.allocationFor(
      ctx,
      ext.invoiceExternalId,
      ext.amount,
      ext.currency,
    );
    const input = createPaymentSchema.safeParse({
      partyId: customerId,
      paymentType: 'PAYMENT',
      paymentDate: ext.paymentDate,
      amount: ext.amount,
      method: ext.method,
      cashAccountId,
      reference: ext.reference ?? record.externalId,
      memo: ext.memo,
      allocations,
      idempotencyKey: domainIdempotencyKey(ctx, ENTITY, record.externalId),
    });
    if (!input.success) throw mappingError(input.error.issues);

    let detail = await this.payments.create(ctx.companyId, ctx.principal, input.data);
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
      assertScope(ctx, 'customer-payment.post');
      detail = await this.payments.post(ctx.companyId, ctx.principal, detail.id);
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
      'The payer of this payment has not been imported yet.',
      {
        details: { customerExternalId: externalId ?? null, customerCode: code ?? null },
      },
    );
  }

  /** Allocate to the referenced invoice when it is posted and still open; otherwise leave on account. */
  private async allocationFor(
    ctx: ImportContext,
    invoiceExternalId: string | undefined,
    amount: string,
    currency?: string,
  ) {
    if (!invoiceExternalId) return [];
    // The provider's id for the invoice (same integration), else the document reference
    // (e.g. a storefront order number quoted by a separate payment gateway).
    const ref = await this.refs.findByExternal(ctx.integration.id, 'invoices', invoiceExternalId);
    const [inv] = await this.db
      .select({
        id: invoices.id,
        total: invoices.total,
        allocated: invoices.allocatedAmount,
        accountingStatus: invoices.accountingStatus,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          ref ? eq(invoices.id, ref.internalId) : eq(invoices.reference, invoiceExternalId),
          eq(invoices.documentType, 'INVOICE'),
        ),
      )
      .limit(1);
    if (!inv || inv.accountingStatus !== 'POSTED') return [];
    if (currency && currency !== inv.currency) return [];
    const open = Money.of(inv.total, inv.currency).subtract(Money.of(inv.allocated, inv.currency));
    if (!open.isPositive()) return [];
    const paid = Money.of(amount, inv.currency);
    const apply = paid.lessThan(open) ? paid : open;
    return [{ documentId: inv.id, amount: apply.toString() }];
  }
}
