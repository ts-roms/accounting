import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { HEADERS } from '@accounting/config';
import {
  BaseConnector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type ConnectResult,
  type InboundWebhookEvent,
  type PullRequest,
  type PullResult,
  type WebhookHandling,
  type WebhookVerification,
} from '../core/connector';
import { IntegrationError } from '../core/integration-error';
import { hmacHex, safeEqual } from '../webhooks/webhook-signature';
import { fixtureArray, looksLikeDemoSecret, pageFromFixture, toRecords } from './demo-fixtures';

/**
 * Demo e-commerce store (Shopify-like). Customers, products and orders are pulled with
 * a cursor; `order.created` webhooks (plain HMAC over the body) import the
 * order as a DRAFT invoice through InvoicesService; `product.updated` upserts
 * the catalogue record (stock never moves). Orders never post by
 * themselves.
 */
@Injectable()
export class DemoEcommerceConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'DEMO_ECOMMERCE',
    category: 'ECOMMERCE',
    name: 'Demo E-Commerce Store',
    description:
      'Storefront simulator: customers, products and orders become customers, products and invoices.',
    authType: 'BEARER',
    capabilities: ['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    entities: ['customers', 'products', 'invoices'],
    configSchema: z.object({
      storeUrl: z.string().url().optional(),
      /** Revenue account for order lines (defaults to the SALES_REVENUE mapping). */
      revenueAccountId: z.string().uuid().optional(),
      autoPost: z.boolean().default(false),
      fixture: z
        .object({
          customers: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
          orders: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
          products: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
        })
        .optional(),
    }),
    credentialFields: [
      { key: 'bearerToken', label: 'Store access token (demo-shop-...)', required: true },
      { key: 'webhookSecret', label: 'Webhook HMAC secret', required: false },
    ],
    defaultMappings: {
      customers: [
        {
          target: 'code',
          source: 'id',
          transforms: [{ name: 'template', arg: 'EC-{value}' }, { name: 'upper' }],
          required: true,
        },
        { target: 'name', source: 'name', transforms: [{ name: 'trim' }], required: true },
        { target: 'email', source: 'email', transforms: [{ name: 'lower' }] },
        { target: 'phone', source: 'phone', transforms: [] },
        { target: 'addressLine1', source: 'address.line1', transforms: [] },
        { target: 'city', source: 'address.city', transforms: [] },
        {
          target: 'country',
          source: 'address.country',
          transforms: [{ name: 'upper' }],
          default: 'PH',
        },
        { target: 'paymentTermsDays', default: 0, transforms: [{ name: 'toInteger' }] },
      ],
      products: [
        {
          target: 'sku',
          source: 'sku',
          transforms: [{ name: 'trim' }, { name: 'upper' }],
          required: true,
        },
        { target: 'name', source: 'title', transforms: [{ name: 'trim' }], required: true },
        { target: 'description', source: 'body', transforms: [] },
        { target: 'barcode', source: 'barcode', transforms: [{ name: 'toString' }] },
        { target: 'salePrice', source: 'price', transforms: [{ name: 'toDecimal' }] },
        { target: 'purchasePrice', source: 'cost', transforms: [{ name: 'toDecimal' }] },
        {
          target: 'productType',
          source: 'product_type',
          transforms: [{ name: 'trim' }, { name: 'upper' }],
          default: 'GOODS',
        },
        { target: 'unitOfMeasure', source: 'unit', transforms: [{ name: 'trim' }], default: 'pc' },
      ],
      invoices: [
        {
          target: 'customerExternalId',
          source: 'customer_id',
          transforms: [{ name: 'toString' }],
          required: true,
        },
        {
          target: 'documentDate',
          source: 'created_at',
          transforms: [{ name: 'toDate' }],
          required: true,
        },
        { target: 'reference', source: 'order_number', transforms: [{ name: 'toString' }] },
        { target: 'description', source: 'note', transforms: [] },
        { target: 'currency', source: 'currency', transforms: [{ name: 'upper' }] },
        {
          target: 'lines',
          source: 'line_items',
          required: true,
          transforms: [
            {
              name: 'mapEach',
              arg: [
                {
                  target: 'description',
                  source: 'title',
                  transforms: [{ name: 'trim' }],
                  required: true,
                },
                {
                  target: 'quantity',
                  source: 'quantity',
                  transforms: [{ name: 'toDecimal' }],
                  default: '1',
                },
                {
                  target: 'unitPrice',
                  source: 'price',
                  transforms: [{ name: 'toDecimal' }],
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    },
    rateLimitPerSecond: 4,
    webhookSignature: 'PLAIN_HMAC',
    demo: true,
  };

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    if (!looksLikeDemoSecret(ctx.secrets.bearerToken, 'demo-shop-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Store rejected the access token (expected demo-shop-...).',
        { httpStatus: 401 },
      );
    return { ok: true, message: `Connected to ${String(ctx.config.storeUrl ?? 'demo store')}` };
  }

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    if (!looksLikeDemoSecret(ctx.secrets.bearerToken, 'demo-shop-'))
      throw new IntegrationError('AUTHENTICATION_ERROR', 'Store rejected the access token.', {
        httpStatus: 401,
      });
    const rows =
      req.entity === 'customers'
        ? fixtureArray(ctx.config, 'customers')
        : req.entity === 'products'
          ? fixtureArray(ctx.config, 'products')
          : req.entity === 'invoices'
            ? fixtureArray(ctx.config, 'orders')
            : [];
    return pageFromFixture(toRecords(rows), req.cursor, req.limit);
  }

  async verifyWebhook(
    ctx: ConnectorContext,
    input: { headers: Record<string, string | undefined>; rawBody: string; body: unknown },
  ): Promise<WebhookVerification> {
    const secret = ctx.secrets.webhookSecret;
    if (!secret) return { ok: false, reason: 'NO_SECRET' };
    const provided = input.headers['x-demo-shop-hmac'] ?? input.headers[HEADERS.WEBHOOK_SIGNATURE];
    if (!provided) return { ok: false, reason: 'MALFORMED' };
    const expected = hmacHex(secret, input.rawBody);
    if (!safeEqual(provided, expected)) return { ok: false, reason: 'MISMATCH' };
    const topic = input.headers['x-demo-shop-topic'] ?? 'order.created';
    const body = input.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || body.id === undefined)
      return { ok: false, reason: 'MALFORMED_BODY' };
    const eventId =
      typeof body.event_id === 'string' ? body.event_id : `${topic}:${String(body.id)}`;
    return { ok: true, event: { eventId, eventType: topic, payload: body } };
  }

  async handleWebhook(
    _ctx: ConnectorContext,
    event: InboundWebhookEvent,
  ): Promise<WebhookHandling> {
    if (event.eventType === 'order.created' || event.eventType === 'orders/create') {
      const imports: WebhookHandling['imports'] = [];
      const customer = event.payload.customer;
      if (
        customer &&
        typeof customer === 'object' &&
        (customer as Record<string, unknown>).id !== undefined
      )
        imports.push({
          entity: 'customers',
          record: {
            externalId: String((customer as Record<string, unknown>).id),
            data: customer as Record<string, unknown>,
          },
        });
      const order = {
        ...event.payload,
        customer_id:
          event.payload.customer_id ?? (customer as Record<string, unknown> | undefined)?.id,
      };
      imports.push({
        entity: 'invoices',
        record: { externalId: String(event.payload.id), data: order },
      });
      return { imports };
    }
    if (
      event.eventType === 'product.created' ||
      event.eventType === 'product.updated' ||
      event.eventType === 'products/update'
    )
      return {
        imports: [
          {
            entity: 'products',
            record: { externalId: String(event.payload.id), data: event.payload },
          },
        ],
      };
    if (event.eventType === 'customer.updated' || event.eventType === 'customers/update')
      return {
        imports: [
          {
            entity: 'customers',
            record: { externalId: String(event.payload.id), data: event.payload },
          },
        ],
      };
    return { imports: [], note: `ignored ${event.eventType}` };
  }
}
