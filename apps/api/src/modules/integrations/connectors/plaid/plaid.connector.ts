import { Injectable } from '@nestjs/common';
import type { JsonWebKey } from 'node:crypto';
import { z } from 'zod';
import {
  BaseConnector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type ConnectResult,
  type InboundWebhookEvent,
  type PullRequest,
  type PullResult,
  type TestConnectionResult,
  type WebhookHandling,
  type WebhookVerification,
} from '../../core/connector';
import { IntegrationError } from '../../core/integration-error';
import {
  buildStatements,
  classifyPlaidError,
  decodeCursor,
  encodeCursor,
  environmentBaseUrl,
  isPlaidWebhook,
  parsePlaidJwt,
  pickAccount,
  verifyPlaidJwt,
  wantsSync,
  type PlaidAccount,
  type PlaidSyncResponse,
} from './plaid.logic';

/** Plaid caps `/transactions/sync` at 500 per page. */
const PLAID_MAX_COUNT = 500;

/**
 * Plaid (bank feeds). Client id + secret authenticate the app, a per-item
 * access token authorises one bank connection. `connect` accepts either the
 * access token or the short-lived public token from Plaid Link and exchanges
 * it, storing the access token encrypted. `/transactions/sync` pages are
 * turned into one statement per posting date (running balances continue
 * from the stored cursor) and imported through StatementsService - never
 * as ledger entries; reconciliation matches them in the banking module.
 * `TRANSACTIONS` webhooks (ES256 JWT in `Plaid-Verification`, key fetched
 * by `kid`) trigger an incremental sync.
 *
 * Deliberately not imported: pending transactions (a statement is evidence
 * of what cleared; Plaid re-delivers the posted version), and modifications
 * / removals of already imported lines, which are logged for the operator.
 */
@Injectable()
export class PlaidConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'PLAID',
    category: 'BANKING',
    name: 'Plaid',
    description:
      'Bank transactions through Plaid, delivered as daily statements for reconciliation.',
    authType: 'BASIC',
    capabilities: ['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    entities: ['bank-transactions'],
    configSchema: z.object({
      /** Internal bank account the feed belongs to. */
      bankAccountId: z.string().uuid(),
      environment: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
      /** Plaid account_id within the item; optional when the item has exactly one depository account. */
      plaidAccountId: z.string().trim().min(1).max(80).optional(),
      /** Bank balance at the start of the feed: the first statement opens with it. */
      openingBalance: z
        .string()
        .trim()
        .regex(/^-?\d+(\.\d{1,4})?$/)
        .default('0'),
      /** Import pending (uncleared) transactions too. */
      includePending: z.boolean().default(false),
      /** Base URL override for proxies / mocks (defaults to the environment's Plaid host). */
      apiBaseUrl: z.string().url().optional(),
    }),
    credentialFields: [
      { key: 'username', label: 'Plaid client id', required: true },
      { key: 'password', label: 'Plaid secret (sandbox or production)', required: true },
      {
        key: 'bearerToken',
        label: 'Item access token (access-...) or Link public token (public-...)',
        required: true,
      },
    ],
    defaultMappings: {
      'bank-transactions': [
        {
          target: 'statementDate',
          source: 'statement_date',
          transforms: [{ name: 'toDate' }],
          required: true,
        },
        {
          target: 'openingBalance',
          source: 'opening_balance',
          transforms: [{ name: 'toDecimal' }],
          required: true,
        },
        {
          target: 'closingBalance',
          source: 'closing_balance',
          transforms: [{ name: 'toDecimal' }],
          required: true,
        },
        {
          target: 'lines',
          source: 'transactions',
          required: true,
          transforms: [
            {
              name: 'mapEach',
              arg: [
                {
                  target: 'lineDate',
                  source: 'date',
                  transforms: [{ name: 'toDate' }],
                  required: true,
                },
                {
                  target: 'description',
                  source: 'description',
                  transforms: [{ name: 'trim' }],
                  required: true,
                },
                { target: 'reference', source: 'reference', transforms: [] },
                {
                  target: 'amount',
                  source: 'amount',
                  transforms: [{ name: 'toDecimal' }],
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    },
    rateLimitPerSecond: 10,
  };

  // ---------------------------------------------------------------- helpers

  private baseUrl(ctx: ConnectorContext): string {
    const override = ctx.config.apiBaseUrl;
    const base =
      typeof override === 'string' && override
        ? override
        : environmentBaseUrl(String(ctx.config.environment ?? 'SANDBOX'));
    return base.replace(/\/$/, '');
  }

  /** Every Plaid call is a JSON POST; client credentials travel as headers, never in logged bodies. */
  private async plaidPost<T>(
    ctx: ConnectorContext,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const clientId = ctx.secrets.username;
    const secret = ctx.secrets.password;
    if (!clientId || !secret)
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'No Plaid client id / secret is stored for this integration.',
        { httpStatus: 401 },
      );
    try {
      const res = await ctx.http(`${this.baseUrl(ctx)}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'plaid-client-id': clientId,
          'plaid-secret': secret,
        },
        body: JSON.stringify(body),
      });
      return (await res.json()) as T;
    } catch (err) {
      const ie = IntegrationError.from(err);
      if (ie.options.httpStatus === undefined) throw ie;
      const classified = classifyPlaidError(ie.options.httpStatus, ie.options.details?.body);
      throw new IntegrationError(classified.code, classified.message, {
        httpStatus: ie.options.httpStatus,
        retryAfterMs: ie.options.retryAfterMs,
        details: { plaidCode: classified.plaidCode, path },
        cause: err,
      });
    }
  }

  private accessToken(ctx: ConnectorContext): string {
    const token = ctx.secrets.bearerToken;
    if (!token || !token.startsWith('access-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'No Plaid access token is stored; connect the integration with a Link public token first.',
        { httpStatus: 401 },
      );
    return token;
  }

  private async accounts(ctx: ConnectorContext, accessToken: string): Promise<PlaidAccount[]> {
    const res = await this.plaidPost<{ accounts: PlaidAccount[]; item?: { item_id?: string } }>(
      ctx,
      '/accounts/get',
      { access_token: accessToken },
    );
    return res.accounts ?? [];
  }

  private configuredAccount(ctx: ConnectorContext): string | undefined {
    const v = ctx.config.plaidAccountId;
    return typeof v === 'string' && v ? v : undefined;
  }

  // ------------------------------------------------------------ connection

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    let token = ctx.secrets.bearerToken ?? '';
    const secrets: ConnectResult['secrets'] = {};
    if (token.startsWith('public-')) {
      // Plaid Link handed the operator a 30-minute public token: exchange it once and keep the access token.
      const exchanged = await this.plaidPost<{ access_token: string; item_id: string }>(
        ctx,
        '/item/public_token/exchange',
        { public_token: token },
      );
      token = exchanged.access_token;
      secrets.bearerToken = token;
    }
    if (!token.startsWith('access-'))
      throw new IntegrationError(
        'AUTHENTICATION_ERROR',
        'Provide a Plaid access token (access-...) or a Link public token (public-...).',
        { httpStatus: 401 },
      );
    const accounts = await this.accounts(ctx, token);
    const picked = pickAccount(accounts, this.configuredAccount(ctx));
    if (!picked.account) throw new IntegrationError('VALIDATION_ERROR', picked.reason ?? '');
    const a = picked.account;
    return {
      ok: true,
      message: `Connected to ${a.official_name ?? a.name}${a.mask ? ` (****${a.mask})` : ''} via Plaid ${String(ctx.config.environment ?? 'SANDBOX').toLowerCase()}`,
      externalAccountId: a.account_id,
      secrets: Object.keys(secrets).length ? secrets : undefined,
    };
  }

  override async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const started = Date.now();
    try {
      const accounts = await this.accounts(ctx, this.accessToken(ctx));
      const picked = pickAccount(accounts, this.configuredAccount(ctx));
      if (!picked.account)
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: picked.reason ?? 'No account selected.',
          details: { accounts: accounts.map((a) => ({ id: a.account_id, name: a.name })) },
        };
      const balance = picked.account.balances?.current;
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `Feed OK for ${picked.account.name}`,
        details: {
          accountId: picked.account.account_id,
          currency: picked.account.balances?.iso_currency_code ?? null,
          currentBalance: balance ?? null,
          environment: ctx.config.environment ?? 'SANDBOX',
        },
      };
    } catch (err) {
      const ie = IntegrationError.from(err);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: ie.message,
        details: { code: ie.code, ...ie.options.details },
      };
    }
  }

  // ------------------------------------------------------------------ pull

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    if (req.entity !== 'bank-transactions')
      return { records: [], nextCursor: null, hasMore: false };
    const accessToken = this.accessToken(ctx);
    const opening = String(ctx.config.openingBalance ?? '0');
    // The engine hands over null for the first page of a FULL run and the stored cursor otherwise.
    const cursor = decodeCursor(req.cursor, opening);
    const page = await this.plaidPost<PlaidSyncResponse>(ctx, '/transactions/sync', {
      access_token: accessToken,
      cursor: cursor.cursor ?? undefined,
      count: Math.min(Math.max(req.limit, 1), PLAID_MAX_COUNT),
      options: { include_original_description: false },
    });
    let accountId = this.configuredAccount(ctx);
    if (!accountId) {
      const picked = pickAccount(
        page.accounts ?? (await this.accounts(ctx, accessToken)),
        undefined,
      );
      if (!picked.account) throw new IntegrationError('VALIDATION_ERROR', picked.reason ?? '');
      accountId = picked.account.account_id;
    }
    const built = buildStatements(page, {
      accountId,
      runningBalance: cursor.balance,
      includePending: ctx.config.includePending === true,
    });
    if (page.modified.length || page.removed.length)
      ctx.logger.warn(
        { modified: page.modified.length, removed: page.removed.length },
        'Plaid reported changed or removed transactions; imported statement lines are kept as delivered',
      );
    if (built.skippedPending)
      ctx.logger.info({ skippedPending: built.skippedPending }, 'Pending transactions skipped');
    return {
      records: built.records,
      nextCursor: encodeCursor({ cursor: page.next_cursor, balance: built.runningBalance }),
      hasMore: Boolean(page.has_more),
    };
  }

  // -------------------------------------------------------------- webhooks

  async verifyWebhook(
    ctx: ConnectorContext,
    input: { headers: Record<string, string | undefined>; rawBody: string; body: unknown },
  ): Promise<WebhookVerification> {
    const jwt = parsePlaidJwt(input.headers['plaid-verification']);
    if (!jwt) return { ok: false, reason: 'MALFORMED' };
    if (!jwt.header.kid) return { ok: false, reason: 'MALFORMED' };
    // The signing key is public and rotates: fetch it by kid through the throttled client.
    let keyRes: { key?: JsonWebKey & { expired_at?: number | null } };
    try {
      keyRes = await this.plaidPost<typeof keyRes>(ctx, '/webhook_verification_key/get', {
        key_id: jwt.header.kid,
      });
    } catch (err) {
      // An unknown kid (or a Plaid outage) is a rejected delivery, never a crash: Plaid will retry.
      ctx.logger.warn(
        { err: IntegrationError.from(err).code, kid: jwt.header.kid },
        'Webhook key lookup failed',
      );
      return { ok: false, reason: 'KEY_LOOKUP_FAILED' };
    }
    if (!keyRes.key) return { ok: false, reason: 'NO_KEY' };
    if (keyRes.key.expired_at) return { ok: false, reason: 'KEY_EXPIRED' };
    const result = verifyPlaidJwt(jwt, keyRes.key, input.rawBody);
    if (!result.ok) return { ok: false, reason: result.reason };
    if (!isPlaidWebhook(input.body)) return { ok: false, reason: 'MALFORMED_BODY' };
    const body = input.body;
    const eventId = `${body.webhook_type}:${body.webhook_code}:${String(body.item_id ?? '')}:${jwt.payload.request_body_sha256 ?? ''}`;
    return {
      ok: true,
      event: {
        eventId,
        eventType: `${body.webhook_type}.${body.webhook_code}`,
        payload: body,
      },
    };
  }

  async handleWebhook(
    _ctx: ConnectorContext,
    event: InboundWebhookEvent,
  ): Promise<WebhookHandling> {
    const [type, code] = event.eventType.split('.', 2);
    if (type && code && wantsSync(type, code))
      return { imports: [], syncEntities: ['bank-transactions'] };
    if (type === 'ITEM' && code === 'ERROR')
      return {
        imports: [],
        note: `Plaid item error: ${String((event.payload.error as { error_code?: string } | undefined)?.error_code ?? 'unknown')} - the bank connection needs re-authentication`,
      };
    return { imports: [], note: `ignored ${event.eventType}` };
  }
}
