import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  BaseConnector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type ConnectResult,
  type ExternalRecord,
  type InboundWebhookEvent,
  type PullRequest,
  type PullResult,
  type TestConnectionResult,
  type WebhookHandling,
  type WebhookVerification,
} from '../../core/connector';
import { IntegrationError } from '../../core/integration-error';
import { verifySignature } from '../../webhooks/webhook-signature';
import {
  advanceCursor,
  decodeCursor,
  encodeCursor,
  isSettledCharge,
  isStripeEvent,
  keyMode,
  listParams,
  normalizeCharge,
  normalizeCheckoutSession,
  normalizeCustomer,
  normalizeEventType,
  normalizePaymentIntent,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeCustomer,
  type StripePaymentIntent,
} from './stripe.logic';

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';
export const STRIPE_API_VERSION = '2024-06-20';

interface StripeList<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

/**
 * Stripe (payments). Authenticates with a restricted or secret API key,
 * pulls customers and settled charges with cursor pagination and
 * `created[gt]` incremental bounds, and receives `charge.succeeded`,
 * `payment_intent.succeeded`, `checkout.session.completed` and customer
 * events through Stripe-signed webhooks. Every payment becomes a customer
 * receipt through the PaymentsImporter -> CustomerPaymentsService; posting
 * to the ledger still requires the `payments:post` scope and `autoPost`.
 *
 * Refunds, disputes and payouts are deliberately not imported (see docs).
 */
@Injectable()
export class StripeConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'STRIPE',
    category: 'PAYMENT',
    name: 'Stripe',
    description:
      'Customers and settled payments from Stripe; signed webhooks for real-time receipts.',
    authType: 'API_KEY',
    capabilities: ['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    entities: ['customers', 'payments'],
    configSchema: z.object({
      /** GL cash / clearing account Stripe settles into (e.g. "Stripe clearing"). */
      cashAccountId: z.string().uuid(),
      /** Post receipts automatically (needs the payments:post scope). */
      autoPost: z.boolean().default(false),
      /** Customer code used for guest checkouts (charges without a Stripe customer). */
      guestCustomerCode: z.string().trim().min(1).max(32).optional(),
      /** Stripe-Version header; pin to the version your account was tested with. */
      apiVersion: z
        .string()
        .trim()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .default(STRIPE_API_VERSION),
      /** Base URL override for sandboxes / proxies (defaults to api.stripe.com). */
      apiBaseUrl: z.string().url().default(STRIPE_API_BASE),
    }),
    credentialFields: [
      { key: 'apiKey', label: 'Secret or restricted API key (sk_... / rk_...)', required: true },
      {
        key: 'webhookSecret',
        label: 'Webhook endpoint signing secret (whsec_...)',
        required: false,
      },
    ],
    defaultMappings: {
      customers: [
        {
          target: 'code',
          source: 'id',
          transforms: [{ name: 'template', arg: 'STRIPE-{value}' }, { name: 'upper' }],
          required: true,
        },
        { target: 'name', source: 'display_name', transforms: [{ name: 'trim' }], required: true },
        { target: 'legalName', source: 'name', transforms: [] },
        { target: 'email', source: 'email', transforms: [{ name: 'lower' }] },
        { target: 'phone', source: 'phone', transforms: [] },
        { target: 'addressLine1', source: 'address.line1', transforms: [] },
        { target: 'addressLine2', source: 'address.line2', transforms: [] },
        { target: 'city', source: 'address.city', transforms: [] },
        { target: 'province', source: 'address.state', transforms: [] },
        { target: 'postalCode', source: 'address.postal_code', transforms: [] },
        {
          target: 'country',
          source: 'address.country',
          transforms: [{ name: 'upper' }],
          default: 'PH',
        },
        { target: 'currency', source: 'currency', transforms: [{ name: 'upper' }] },
        { target: 'paymentTermsDays', default: 0, transforms: [{ name: 'toInteger' }] },
      ],
      payments: [
        { target: 'customerExternalId', source: 'customer', transforms: [] },
        { target: 'customerCode', source: 'customer_code', transforms: [] },
        { target: 'invoiceExternalId', source: 'metadata.invoice_reference', transforms: [] },
        {
          target: 'paymentDate',
          source: 'created_at',
          transforms: [{ name: 'toDate' }],
          required: true,
        },
        { target: 'amount', source: 'amount', transforms: [{ name: 'toDecimal' }], required: true },
        { target: 'currency', source: 'currency', transforms: [{ name: 'upper' }] },
        { target: 'reference', source: 'id', transforms: [] },
        { target: 'memo', source: 'description', transforms: [] },
        { target: 'status', source: 'status', transforms: [] },
        { target: 'method', default: 'CARD', transforms: [] },
      ],
    },
    rateLimitPerSecond: 25,
    webhookSignature: 'TIMESTAMPED',
  };

  // ---------------------------------------------------------------- helpers

  private async stripeGet<T>(
    ctx: ConnectorContext,
    path: string,
    params?: URLSearchParams,
  ): Promise<T> {
    const key = ctx.secrets.apiKey;
    if (!key)
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'No Stripe API key is stored for this integration.',
        { httpStatus: 401 },
      );
    const base = String(ctx.config.apiBaseUrl ?? STRIPE_API_BASE).replace(/\/$/, '');
    const url = `${base}${path}${params && [...params.keys()].length ? `?${params.toString()}` : ''}`;
    const res = await ctx.http(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        'stripe-version': String(ctx.config.apiVersion ?? STRIPE_API_VERSION),
        accept: 'application/json',
      },
    });
    return (await res.json()) as T;
  }

  private guestCode(ctx: ConnectorContext): string | undefined {
    const v = ctx.config.guestCustomerCode;
    return typeof v === 'string' && v.length ? v : undefined;
  }

  // ------------------------------------------------------------ connection

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    const account = await this.stripeGet<{
      id: string;
      business_profile?: { name?: string | null };
      settings?: { dashboard?: { display_name?: string | null } };
    }>(ctx, '/account');
    const name =
      account.business_profile?.name ?? account.settings?.dashboard?.display_name ?? account.id;
    return {
      ok: true,
      message: `Connected to Stripe account ${name} (${keyMode(ctx.secrets.apiKey)} mode)`,
      externalAccountId: account.id,
    };
  }

  override async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const started = Date.now();
    try {
      const result = await this.connect(ctx);
      const details: Record<string, unknown> = {
        account: result.externalAccountId,
        mode: keyMode(ctx.secrets.apiKey),
      };
      if (!ctx.secrets.webhookSecret)
        details.warning = 'No webhook signing secret stored: inbound events will be rejected.';
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: result.message ?? 'Connection OK',
        details,
      };
    } catch (err) {
      const ie = IntegrationError.from(err);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: ie.message,
        details: { code: ie.code },
      };
    }
  }

  // ------------------------------------------------------------------ pull

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    const cursor = decodeCursor(req.cursor);
    const params = listParams(cursor, req.limit, req.mode);
    if (req.entity === 'customers') {
      const list = await this.stripeGet<StripeList<StripeCustomer>>(ctx, '/customers', params);
      const records: ExternalRecord[] = list.data
        .filter((c) => !c.deleted)
        .map((c) => ({
          externalId: c.id,
          data: normalizeCustomer(c),
          updatedAt: c.created ? new Date(c.created * 1000).toISOString() : undefined,
        }));
      return this.page(cursor, list, records);
    }
    if (req.entity === 'payments') {
      const list = await this.stripeGet<StripeList<StripeCharge>>(ctx, '/charges', params);
      const guest = this.guestCode(ctx);
      const records: ExternalRecord[] = list.data
        .filter((c) => isSettledCharge(c))
        .map((c) => ({
          externalId: c.id,
          data: normalizeCharge(c, guest),
          updatedAt: c.created ? new Date(c.created * 1000).toISOString() : undefined,
        }));
      return this.page(cursor, list, records);
    }
    return { records: [], nextCursor: null, hasMore: false };
  }

  private page<T extends { id: string; created?: number }>(
    cursor: ReturnType<typeof decodeCursor>,
    list: StripeList<T>,
    records: ExternalRecord[],
  ): PullResult {
    const lastId = list.data.length ? list.data[list.data.length - 1]!.id : null;
    const maxCreated = list.data.reduce<number | undefined>(
      (m, o) => (o.created !== undefined && (m === undefined || o.created > m) ? o.created : m),
      undefined,
    );
    const { next, hasMore } = advanceCursor(cursor, {
      lastId,
      hasMore: Boolean(list.has_more),
      maxCreated,
    });
    return { records, nextCursor: encodeCursor(next), hasMore };
  }

  // -------------------------------------------------------------- webhooks

  async verifyWebhook(
    ctx: ConnectorContext,
    input: { headers: Record<string, string | undefined>; rawBody: string; body: unknown },
  ): Promise<WebhookVerification> {
    const secret = ctx.secrets.webhookSecret;
    if (!secret) return { ok: false, reason: 'NO_SECRET' };
    // Stripe: `Stripe-Signature: t=<unix>,v1=<hmac>` over `${t}.${rawBody}` - the platform's timestamped scheme.
    const result = verifySignature([secret], input.rawBody, input.headers['stripe-signature']);
    if (!result.ok) return { ok: false, reason: result.reason };
    if (!isStripeEvent(input.body)) return { ok: false, reason: 'MALFORMED_BODY' };
    const mode = keyMode(ctx.secrets.apiKey);
    if (
      typeof input.body.livemode === 'boolean' &&
      mode !== 'unknown' &&
      input.body.livemode !== (mode === 'live')
    )
      return { ok: false, reason: 'LIVEMODE_MISMATCH' };
    return {
      ok: true,
      event: {
        eventId: input.body.id,
        eventType: input.body.type,
        occurredAt: input.body.created
          ? new Date(input.body.created * 1000).toISOString()
          : undefined,
        payload: { type: input.body.type, object: input.body.data?.object ?? null },
      },
    };
  }

  async handleWebhook(ctx: ConnectorContext, event: InboundWebhookEvent): Promise<WebhookHandling> {
    const object = (event.payload.object ?? null) as Record<string, unknown> | null;
    const type = String(event.payload.type ?? event.eventType);
    const guest = this.guestCode(ctx);
    if (!object) return { imports: [], note: `ignored ${type}: no object` };
    switch (type) {
      case 'charge.succeeded': {
        const charge = object as unknown as StripeCharge;
        if (!isSettledCharge(charge))
          return { imports: [], note: `ignored ${type}: charge not settled` };
        return {
          imports: [
            {
              entity: 'payments',
              record: { externalId: charge.id, data: normalizeCharge(charge, guest) },
            },
          ],
        };
      }
      case 'payment_intent.succeeded': {
        const pi = object as unknown as StripePaymentIntent;
        // Prefer the charge id as the external id so a charge.succeeded for the same money is deduplicated.
        const chargeId =
          typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
        return {
          imports: [
            {
              entity: 'payments',
              record: { externalId: chargeId ?? pi.id, data: normalizePaymentIntent(pi, guest) },
            },
          ],
        };
      }
      case 'checkout.session.completed': {
        const session = object as unknown as StripeCheckoutSession;
        if (session.payment_status !== 'paid')
          return { imports: [], note: `ignored ${type}: not paid` };
        const piId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id;
        if (piId)
          return {
            imports: [],
            note: `checkout session ${session.id} settles through payment intent ${piId}`,
          };
        return {
          imports: [
            {
              entity: 'payments',
              record: { externalId: session.id, data: normalizeCheckoutSession(session, guest) },
            },
          ],
        };
      }
      case 'customer.created':
      case 'customer.updated': {
        const customer = object as unknown as StripeCustomer;
        if (customer.deleted) return { imports: [], note: 'deleted customer ignored' };
        return {
          imports: [
            {
              entity: 'customers',
              record: { externalId: customer.id, data: normalizeCustomer(customer) },
            },
          ],
        };
      }
      default:
        return { imports: [], note: `ignored ${normalizeEventType(type)} (${type})` };
    }
  }
}
