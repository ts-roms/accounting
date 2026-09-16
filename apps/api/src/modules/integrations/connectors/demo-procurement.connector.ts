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
import { verifySignature } from '../webhooks/webhook-signature';
import { fixtureArray, looksLikeDemoSecret, pageFromFixture, toRecords } from './demo-fixtures';

/**
 * Demo procurement / supplier portal (Coupa-like). Suppliers and supplier
 * invoices are pulled with a cursor; `invoice.received` webhooks (timestamped
 * HMAC) import the supplier invoice as a DRAFT bill through BillsService.
 * Bills never post by themselves: approve + post needs `bills:post` and
 * `config.autoPost`, and then runs through BillsService exactly as a manual
 * bill (delegated authority included).
 */
@Injectable()
export class DemoProcurementConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'DEMO_PROCUREMENT',
    category: 'PROCUREMENT',
    name: 'Demo Procurement Portal',
    description:
      'Supplier portal simulator: suppliers and supplier invoices become vendors and bills.',
    authType: 'API_KEY',
    capabilities: ['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    entities: ['vendors', 'bills'],
    configSchema: z.object({
      portalUrl: z.string().url().optional(),
      /** Expense account for invoice lines (defaults to the vendor default, then DEFAULT_EXPENSE). */
      expenseAccountId: z.string().uuid().optional(),
      /** Approve and post imported bills (needs the bills:post scope). */
      autoPost: z.boolean().default(false),
      fixture: z
        .object({
          suppliers: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
          invoices: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
        })
        .optional(),
    }),
    credentialFields: [
      { key: 'apiKey', label: 'Portal API key (demo-proc-...)', required: true },
      { key: 'webhookSecret', label: 'Webhook signing secret', required: false },
    ],
    defaultMappings: {
      vendors: [
        {
          target: 'code',
          source: 'id',
          transforms: [{ name: 'template', arg: 'PR-{value}' }, { name: 'upper' }],
          required: true,
        },
        { target: 'name', source: 'name', transforms: [{ name: 'trim' }], required: true },
        { target: 'legalName', source: 'legal_name', transforms: [{ name: 'trim' }] },
        { target: 'taxIdentificationNumber', source: 'tax_id', transforms: [{ name: 'trim' }] },
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
        {
          target: 'paymentTermsDays',
          source: 'payment_terms_days',
          default: 30,
          transforms: [{ name: 'toInteger' }],
        },
      ],
      bills: [
        {
          target: 'vendorExternalId',
          source: 'supplier_id',
          transforms: [{ name: 'toString' }],
          required: true,
        },
        {
          target: 'documentDate',
          source: 'issued_at',
          transforms: [{ name: 'toDate' }],
          required: true,
        },
        { target: 'dueDate', source: 'due_at', transforms: [{ name: 'toDate' }] },
        {
          target: 'vendorInvoiceNumber',
          source: 'invoice_number',
          transforms: [{ name: 'toString' }, { name: 'trim' }],
        },
        { target: 'reference', source: 'po_number', transforms: [{ name: 'toString' }] },
        { target: 'description', source: 'memo', transforms: [] },
        { target: 'currency', source: 'currency', transforms: [{ name: 'upper' }] },
        {
          target: 'lines',
          source: 'lines',
          required: true,
          transforms: [
            {
              name: 'mapEach',
              arg: [
                {
                  target: 'description',
                  source: 'description',
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
                  source: 'unit_price',
                  transforms: [{ name: 'toDecimal' }],
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    },
    rateLimitPerSecond: 5,
    webhookSignature: 'TIMESTAMPED',
    demo: true,
  };

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-proc-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Procurement portal rejected the API key (expected demo-proc-...).',
        { httpStatus: 401 },
      );
    return { ok: true, message: `Connected to ${String(ctx.config.portalUrl ?? 'demo portal')}` };
  }

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-proc-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Procurement portal rejected the API key.',
        {
          httpStatus: 401,
        },
      );
    const rows =
      req.entity === 'vendors'
        ? fixtureArray(ctx.config, 'suppliers')
        : req.entity === 'bills'
          ? fixtureArray(ctx.config, 'invoices')
          : [];
    return pageFromFixture(toRecords(rows), req.cursor, req.limit);
  }

  async verifyWebhook(
    ctx: ConnectorContext,
    input: { headers: Record<string, string | undefined>; rawBody: string; body: unknown },
  ): Promise<WebhookVerification> {
    if (!ctx.secrets.webhookSecret) return { ok: false, reason: 'NO_SECRET' };
    const result = verifySignature(
      [ctx.secrets.webhookSecret],
      input.rawBody,
      input.headers[HEADERS.WEBHOOK_SIGNATURE],
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    const body = input.body as { id?: unknown; type?: unknown; data?: unknown } | null;
    if (
      !body ||
      typeof body.id !== 'string' ||
      typeof body.type !== 'string' ||
      !body.data ||
      typeof body.data !== 'object'
    )
      return { ok: false, reason: 'MALFORMED_BODY' };
    return {
      ok: true,
      event: {
        eventId: body.id,
        eventType: body.type,
        payload: body.data as Record<string, unknown>,
      },
    };
  }

  async handleWebhook(
    _ctx: ConnectorContext,
    event: InboundWebhookEvent,
  ): Promise<WebhookHandling> {
    if (event.eventType === 'invoice.received') {
      const imports: WebhookHandling['imports'] = [];
      const supplier = event.payload.supplier;
      if (
        supplier &&
        typeof supplier === 'object' &&
        (supplier as Record<string, unknown>).id !== undefined
      )
        imports.push({
          entity: 'vendors',
          record: {
            externalId: String((supplier as Record<string, unknown>).id),
            data: supplier as Record<string, unknown>,
          },
        });
      const invoice = {
        ...event.payload,
        supplier_id:
          event.payload.supplier_id ?? (supplier as Record<string, unknown> | undefined)?.id,
      };
      imports.push({
        entity: 'bills',
        record: { externalId: String(event.payload.id), data: invoice },
      });
      return { imports };
    }
    if (event.eventType === 'supplier.updated')
      return {
        imports: [
          {
            entity: 'vendors',
            record: { externalId: String(event.payload.id), data: event.payload },
          },
        ],
      };
    return { imports: [], note: `ignored ${event.eventType}` };
  }
}
