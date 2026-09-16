import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { API_BASE_PATH } from '@accounting/config';
import type { OAuthCallbackInput, OAuthStartInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  integrations,
  oauthConnections,
  type Integration,
  type OAuthConnection,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import type { ConnectorContext, IntegrationConnector, OAuthTokens } from '../core/connector';
import { CredentialsService } from '../core/credentials.service';
import { IntegrationError } from '../core/integration-error';
import { IntegrationsService } from '../core/integrations.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  buildAuthorizeUrl,
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
  hashState,
  needsRefresh,
  parseTokenResponse,
  safeReturnTo,
} from './oauth.logic';

const MODULE = 'INTEGRATIONS';
const STATE_TTL_MS = 10 * 60_000;
const JOB_REFRESH = 'oauth-token-refresh';

/**
 * Reusable OAuth 2.0 / OIDC authorisation-code flow with PKCE. The state is
 * stored hashed with a 10-minute expiry and consumed exactly once; tokens are
 * encrypted at rest and never logged or returned. Providers without a
 * standard token endpoint (and mocks) override the exchange on the connector.
 */
@Injectable()
export class OAuthService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly integrations: IntegrationsService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
    private readonly logs: IntegrationLogsService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobRunnerService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OAuthService.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.INTEGRATION_MAINTENANCE, JOB_REFRESH, () => this.refreshExpiring());
    void this.jobs.schedule(
      QUEUES.INTEGRATION_MAINTENANCE,
      JOB_REFRESH,
      { every: 5 * 60_000 },
      {},
      'Refresh OAuth tokens that expire soon',
    );
  }

  redirectUri(): string {
    const base = this.config.env.OAUTH_REDIRECT_BASE_URL ?? this.config.env.WEB_BASE_URL;
    return `${base.replace(/\/$/, '')}${API_BASE_PATH}/integrations/oauth/callback`;
  }

  /** Step 1: build the provider authorisation URL and remember the state. */
  async start(
    actor: AuthenticatedUser,
    integrationId: string,
    input: OAuthStartInput,
  ): Promise<{ authorizationUrl: string; expiresAt: Date }> {
    const integration = await this.integrations.getRow(actor.organizationId, integrationId);
    const connector = this.integrations.connector(integration.provider);
    const oauth = connector.descriptor.oauth;
    if (!oauth)
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'This provider does not use OAuth.',
      );
    const clientId = integration.config.clientId;
    if (typeof clientId !== 'string' || !clientId)
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_CONFIG_INVALID,
        'Set clientId in the integration configuration first.',
      );
    const state = generateState();
    const verifier = oauth.pkce === false ? undefined : generateCodeVerifier();
    const expiresAt = new Date(Date.now() + STATE_TTL_MS);
    await this.db
      .insert(oauthConnections)
      .values({
        integrationId,
        provider: integration.provider,
        status: 'PENDING',
        stateHash: hashState(state),
        stateExpiresAt: expiresAt,
        codeVerifierCiphertext: verifier ? this.credentials.cipher.encrypt(verifier) : null,
        redirectUri: this.redirectUri(),
        returnTo: input.returnTo ?? null,
        scopes: [...oauth.scopes],
      })
      .onConflictDoUpdate({
        target: oauthConnections.integrationId,
        set: {
          stateHash: hashState(state),
          stateExpiresAt: expiresAt,
          codeVerifierCiphertext: verifier ? this.credentials.cipher.encrypt(verifier) : null,
          redirectUri: this.redirectUri(),
          returnTo: input.returnTo ?? null,
          scopes: [...oauth.scopes],
          lastError: null,
        },
      });
    await this.db
      .update(integrations)
      .set({ status: 'CONNECTING' })
      .where(eq(integrations.id, integrationId));
    const authorizationUrl = buildAuthorizeUrl({
      authorizeUrl: oauth.authorizeUrl,
      clientId,
      redirectUri: this.redirectUri(),
      scopes: oauth.scopes,
      state,
      codeChallenge: verifier ? codeChallengeS256(verifier) : undefined,
      extra: oauth.extraAuthorizeParams,
    });
    await this.logs.record({
      organizationId: integration.organizationId,
      integrationId,
      direction: 'OUTBOUND',
      operation: 'oauth.start',
      status: 'SUCCESS',
      metadata: { scopes: oauth.scopes },
    });
    return { authorizationUrl, expiresAt };
  }

  /** Step 2: provider redirect. Validates state (single use, unexpired), exchanges the code, stores tokens. */
  async callback(input: OAuthCallbackInput): Promise<{ redirectTo: string }> {
    const [conn] = await this.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.stateHash, hashState(input.state)));
    if (!conn || !conn.stateExpiresAt)
      throw new BusinessRuleError(
        ErrorCodes.OAUTH_STATE_INVALID,
        'Unknown or already used OAuth state.',
      );
    const integration = await this.integrations.findAnyById(conn.integrationId);
    if (!integration)
      throw new BusinessRuleError(ErrorCodes.OAUTH_STATE_INVALID, 'Integration no longer exists.');
    const fallback = `/admin/integrations/${integration.id}`;
    const fail = async (message: string) => {
      await this.db
        .update(oauthConnections)
        .set({
          status: 'FAILED',
          stateHash: null,
          stateExpiresAt: null,
          codeVerifierCiphertext: null,
          lastError: message.slice(0, 500),
        })
        .where(eq(oauthConnections.id, conn.id));
      await this.db
        .update(integrations)
        .set({ status: 'DISCONNECTED' })
        .where(eq(integrations.id, integration.id));
      await this.logs.record({
        organizationId: integration.organizationId,
        integrationId: integration.id,
        direction: 'INBOUND',
        operation: 'oauth.callback',
        status: 'FAILURE',
        errorCode: 'AUTHENTICATION_ERROR',
        message,
      });
      return {
        redirectTo: safeReturnTo(
          `${fallback}?oauth=error&reason=${encodeURIComponent(message.slice(0, 80))}`,
          this.config.env.WEB_BASE_URL,
          fallback,
        ),
      };
    };
    if (conn.stateExpiresAt.getTime() < Date.now()) return fail('OAuth state expired.');
    if (input.error) return fail(input.error_description ?? input.error);
    if (!input.code) return fail('Provider returned no authorisation code.');

    const connector = this.integrations.connector(integration.provider);
    const ctx = await this.integrations.context(integration);
    const verifier = conn.codeVerifierCiphertext
      ? this.credentials.cipher.decrypt(conn.codeVerifierCiphertext)
      : undefined;
    let tokens: OAuthTokens;
    try {
      tokens = await this.exchange(connector, ctx, {
        code: input.code,
        redirectUri: conn.redirectUri ?? this.redirectUri(),
        codeVerifier: verifier,
      });
    } catch (err) {
      const ie = IntegrationError.from(err);
      this.logger.warn(
        { integrationId: integration.id, code: ie.code },
        'OAuth code exchange failed',
      );
      return fail(`Token exchange failed (${ie.code}).`);
    }
    const expiresAt = tokens.expiresInSeconds
      ? new Date(Date.now() + tokens.expiresInSeconds * 1000)
      : null;
    await this.db.transaction(async (tx) => {
      await this.credentials.store(
        tx,
        integration.id,
        {
          oauth: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: expiresAt?.toISOString(),
            tokenType: tokens.tokenType,
          },
        },
        expiresAt,
      );
      await tx
        .update(oauthConnections)
        .set({
          status: 'CONNECTED',
          stateHash: null,
          stateExpiresAt: null,
          codeVerifierCiphertext: null,
          externalAccountId: tokens.externalAccountId ?? null,
          tokenType: tokens.tokenType ?? null,
          accessExpiresAt: expiresAt,
          connectedAt: new Date(),
          lastRefreshedAt: new Date(),
          revokedAt: null,
          lastError: null,
        })
        .where(eq(oauthConnections.id, conn.id));
      await tx
        .update(integrations)
        .set({
          status: 'CONNECTED',
          connectedAt: new Date(),
          lastSuccessAt: new Date(),
          failureCount: 0,
          lastError: null,
        })
        .where(eq(integrations.id, integration.id));
      await this.audit.record(
        {
          action: 'CONNECT',
          module: MODULE,
          entityType: 'Integration',
          entityId: integration.id,
          newValue: {
            via: 'OAUTH2',
            externalAccountId: tokens.externalAccountId ?? null,
            scope: tokens.scope ?? null,
            expiresAt,
          },
          organizationId: integration.organizationId,
          companyId: integration.companyId,
        },
        tx,
      );
    });
    await this.logs.record({
      organizationId: integration.organizationId,
      integrationId: integration.id,
      direction: 'INBOUND',
      operation: 'oauth.callback',
      status: 'SUCCESS',
      message: 'Tokens stored',
    });
    return {
      redirectTo: safeReturnTo(
        conn.returnTo
          ? `${conn.returnTo}${conn.returnTo.includes('?') ? '&' : '?'}oauth=success`
          : `${fallback}?oauth=success`,
        this.config.env.WEB_BASE_URL,
        fallback,
      ),
    };
  }

  /** Refreshes the access token (manual or scheduled). */
  async refresh(integration: Integration, actor?: AuthenticatedUser): Promise<OAuthConnection> {
    const [conn] = await this.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.integrationId, integration.id));
    if (!conn || conn.status !== 'CONNECTED')
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'The integration is not connected through OAuth.',
      );
    const connector = this.integrations.connector(integration.provider);
    const ctx = await this.integrations.context(integration);
    const refreshToken = ctx.secrets.oauth?.refreshToken;
    if (!refreshToken)
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'The provider issued no refresh token; reconnect instead.',
      );
    try {
      const tokens = connector.refreshAccessToken
        ? await connector.refreshAccessToken(ctx, refreshToken)
        : await this.standardRefresh(connector, ctx, refreshToken);
      const expiresAt = tokens.expiresInSeconds
        ? new Date(Date.now() + tokens.expiresInSeconds * 1000)
        : null;
      await this.db.transaction(async (tx) => {
        await this.credentials.store(
          tx,
          integration.id,
          {
            oauth: {
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken ?? refreshToken,
              expiresAt: expiresAt?.toISOString(),
              tokenType: tokens.tokenType,
            },
          },
          expiresAt,
        );
        await tx
          .update(oauthConnections)
          .set({ accessExpiresAt: expiresAt, lastRefreshedAt: new Date(), lastError: null })
          .where(eq(oauthConnections.id, conn.id));
        await this.audit.record(
          {
            action: 'ROTATE',
            module: MODULE,
            entityType: 'IntegrationCredential',
            entityId: integration.id,
            newValue: { kind: 'OAUTH_TOKENS', expiresAt },
            organizationId: integration.organizationId,
            companyId: integration.companyId,
            userId: actor?.id ?? null,
          },
          tx,
        );
      });
      await this.logs.record({
        organizationId: integration.organizationId,
        integrationId: integration.id,
        direction: 'OUTBOUND',
        operation: 'oauth.refresh',
        status: 'SUCCESS',
      });
    } catch (err) {
      const ie = IntegrationError.from(err);
      await this.db
        .update(oauthConnections)
        .set({
          status: ie.code === 'AUTHENTICATION_ERROR' ? 'EXPIRED' : conn.status,
          lastError: ie.message.slice(0, 500),
        })
        .where(eq(oauthConnections.id, conn.id));
      await this.integrations.recordFailure(
        integration,
        'oauth.refresh',
        ie,
        undefined,
        ie.code === 'AUTHENTICATION_ERROR' ? 'ERROR' : null,
      );
      throw new BusinessRuleError(
        ErrorCodes.OAUTH_EXCHANGE_FAILED,
        `Token refresh failed (${ie.code}).`,
      );
    }
    const [fresh] = await this.db
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, conn.id));
    return fresh!;
  }

  /** Revokes with the provider where supported, then wipes the tokens. */
  async disconnect(actor: AuthenticatedUser, integrationId: string): Promise<void> {
    const integration = await this.integrations.getRow(actor.organizationId, integrationId);
    const connector = this.integrations.connector(integration.provider);
    try {
      const ctx = await this.integrations.context(integration);
      if (connector.revokeTokens) await connector.revokeTokens(ctx);
      else if (connector.descriptor.oauth?.revokeUrl && ctx.secrets.oauth?.accessToken)
        await ctx.http(connector.descriptor.oauth.revokeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: ctx.secrets.oauth.accessToken }).toString(),
        });
    } catch (err) {
      this.logger.warn({ err, integrationId }, 'Token revocation failed; wiping locally');
    }
    await this.integrations.disconnect(actor, integrationId, 'OAuth disconnected');
  }

  /** Scheduled: refresh tokens expiring within 15 minutes; warn on refresh failures. */
  async refreshExpiring(): Promise<number> {
    const soon = new Date(Date.now() + 15 * 60_000);
    const due = await this.db
      .select({ integrationId: oauthConnections.integrationId })
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.status, 'CONNECTED'),
          lte(oauthConnections.accessExpiresAt, soon),
          sql`${oauthConnections.accessExpiresAt} IS NOT NULL`,
        ),
      );
    let refreshed = 0;
    for (const { integrationId } of due) {
      const integration = await this.integrations.findAnyById(integrationId);
      if (!integration) continue;
      try {
        await this.refresh(integration);
        refreshed += 1;
      } catch {
        await this.notifications.notify({
          organizationId: integration.organizationId,
          eventType: 'CREDENTIALS_EXPIRING',
          severity: 'WARNING',
          title: `Credentials for "${integration.name}" could not be refreshed`,
          body: 'Reconnect the integration before its access expires.',
          link: `/admin/integrations/${integration.id}`,
          entityType: 'Integration',
          entityId: integration.id,
          permission: 'integration.manage',
          companyId: integration.companyId,
          dedupeKey: `credentials-expiring:${integration.id}`,
        });
      }
    }
    return refreshed;
  }

  /** Whether a call should refresh first (used by connectors through the context). */
  static shouldRefresh(expiresAt: string | undefined): boolean {
    return needsRefresh(expiresAt ? new Date(expiresAt) : null);
  }

  // ------------------------------------------------------------------ helpers

  private async exchange(
    connector: IntegrationConnector,
    ctx: ConnectorContext,
    input: { code: string; redirectUri: string; codeVerifier?: string },
  ): Promise<OAuthTokens> {
    if (connector.exchangeAuthorizationCode) return connector.exchangeAuthorizationCode(ctx, input);
    const oauth = connector.descriptor.oauth!;
    const clientId = String(ctx.config.clientId ?? '');
    const clientSecret = ctx.secrets.apiKey ?? '';
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: clientId,
    });
    if (clientSecret) form.set('client_secret', clientSecret);
    if (input.codeVerifier) form.set('code_verifier', input.codeVerifier);
    const res = await ctx.http(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    const parsed = parseTokenResponse(await res.json());
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresInSeconds: parsed.expires_in,
      tokenType: parsed.token_type,
      scope: parsed.scope,
    };
  }

  private async standardRefresh(
    connector: IntegrationConnector,
    ctx: ConnectorContext,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const oauth = connector.descriptor.oauth!;
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: String(ctx.config.clientId ?? ''),
    });
    if (ctx.secrets.apiKey) form.set('client_secret', ctx.secrets.apiKey);
    const res = await ctx.http(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    const parsed = parseTokenResponse(await res.json());
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresInSeconds: parsed.expires_in,
      tokenType: parsed.token_type,
      scope: parsed.scope,
    };
  }
}
