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
 * Demo payment gateway (Stripe-like). Sends `payment.received` webhooks
 * signed with the shared webhook secret (timestamped HMAC) and supports
 * pulling settled payments. Every payment becomes a customer receipt through
 * CustomerPaymentsService; posting requires the explicit `payments:post` scope.
 */
@Injectable()
export class DemoPaymentGatewayConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'DEMO_PAYMENT_GATEWAY',
    category: 'PAYMENT',
    name: 'Demo Payment Gateway',
    description: 'Payment gateway simulator: signed payment webhooks and settlement pulls.',
    authType: 'HMAC',
    capabilities: ['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    entities: ['customers', 'payments'],
    configSchema: z.object({
      /** GL cash / clearing account the gateway settles into. */
      cashAccountId: z.string().uuid(),
      /** Post receipts automatically (needs the payments:post scope). */
      autoPost: z.boolean().default(false),
      fixture: z
        .object({
          customers: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
          payments: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
        })
        .optional(),
    }),
    credentialFields: [
      { key: 'apiKey', label: 'Secret key (demo-pg-...)', required: true },
      { key: 'webhookSecret', label: 'Webhook signing secret', required: true },
    ],
    defaultMappings: {
      customers: [
        {
          target: 'code',
          source: 'id',
          transforms: [{ name: 'template', arg: 'PG-{value}' }, { name: 'upper' }],
          required: true,
        },
        { target: 'name', source: 'name', transforms: [{ name: 'trim' }], required: true },
        { target: 'email', source: 'email', transforms: [{ name: 'lower' }] },
        { target: 'phone', source: 'phone', transforms: [] },
      ],
      payments: [
        { target: 'customerExternalId', source: 'customer', transforms: [] },
        { target: 'customerCode', source: 'customer_code', transforms: [] },
        { target: 'invoiceExternalId', source: 'metadata.order_id', transforms: [] },
        {
          target: 'paymentDate',
          source: 'created',
          transforms: [{ name: 'toDate' }],
          required: true,
        },
        { target: 'amount', source: 'amount', transforms: [{ name: 'toDecimal' }], required: true },
        { target: 'currency', source: 'currency', transforms: [{ name: 'upper' }] },
        { target: 'reference', source: 'id', transforms: [] },
        { target: 'memo', source: 'description', transforms: [] },
        { target: 'status', source: 'status', transforms: [{ name: 'upper' }] },
        { target: 'method', default: 'BANK_TRANSFER', transforms: [] },
      ],
    },
    rateLimitPerSecond: 10,
    webhookSignature: 'TIMESTAMPED',
    demo: true,
  };

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-pg-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Demo Payment Gateway rejected the secret key (expected demo-pg-...).',
        { httpStatus: 401 },
      );
    if (!ctx.secrets.webhookSecret)
      throw new IntegrationError(
        'VALIDATION_ERROR',
        'A webhook signing secret is required to receive payment events.',
      );
    return { ok: true, message: 'Gateway account verified', externalAccountId: 'acct_demo' };
  }

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    if (!looksLikeDemoSecret(ctx.secrets.apiKey, 'demo-pg-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Demo Payment Gateway rejected the secret key.',
        { httpStatus: 401 },
      );
    const rows =
      req.entity === 'customers'
        ? fixtureArray(ctx.config, 'customers')
        : req.entity === 'payments'
          ? fixtureArray(ctx.config, 'payments')
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
    const body = input.body as {
      id?: unknown;
      type?: unknown;
      created?: unknown;
      data?: unknown;
    } | null;
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
        occurredAt: typeof body.created === 'string' ? body.created : undefined,
        payload: body.data as Record<string, unknown>,
      },
    };
  }

  async handleWebhook(
    _ctx: ConnectorContext,
    event: InboundWebhookEvent,
  ): Promise<WebhookHandling> {
    switch (event.eventType) {
      case 'payment.received':
      case 'invoice.paid':
        return {
          imports: [
            {
              entity: 'payments',
              record: {
                externalId: String(event.payload.id ?? event.eventId),
                data: event.payload,
              },
            },
          ],
        };
      case 'customer.updated':
        return {
          imports: [
            {
              entity: 'customers',
              record: {
                externalId: String(event.payload.id ?? event.eventId),
                data: event.payload,
              },
            },
          ],
        };
      default:
        return { imports: [], note: `ignored ${event.eventType}` };
    }
  }
}
