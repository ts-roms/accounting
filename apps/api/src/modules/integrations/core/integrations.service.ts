import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { IntegrationStatus, PaginatedResult } from '@accounting/types';
import type {
  CreateIntegrationInput,
  ListIntegrationsQuery,
  UpdateIntegrationInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { RequestContext } from '@/common/context/request-context';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  integrationScopes,
  integrations,
  oauthConnections,
  type Integration,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import type {
  ConnectorContext,
  ConnectorDescriptor,
  IntegrationConnector,
  TestConnectionResult,
} from './connector';
import { ConnectorRegistry } from './connector-registry';
import { CredentialsService } from './credentials.service';
import { IntegrationError } from './integration-error';
import { createProviderHttp, ProviderThrottle } from './provider-http';

const MODULE = 'INTEGRATIONS';

export interface IntegrationView extends Integration {
  scopes: string[];
  providerName: string;
  demo: boolean;
  credentials: Array<{ kind: string; expiresAt: Date | null; rotatedAt: Date | null }>;
  oauth: { status: string; accessExpiresAt: Date | null; connectedAt: Date | null } | null;
}

/**
 * Integration registry: the catalogue of connected providers per
 * organization. Owns status transitions (CONNECTING -> CONNECTED / ERROR,
 * DISABLED, soft delete) and builds the `ConnectorContext` every other
 * platform service uses to call a connector.
 */
@Injectable()
export class IntegrationsService {
  readonly throttle = new ProviderThrottle();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly registry: ConnectorRegistry,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
    private readonly logs: IntegrationLogsService,
    private readonly notifications: NotificationsService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IntegrationsService.name);
  }

  providers(): Array<Omit<ConnectorDescriptor, 'configSchema'> & { configFields: string[] }> {
    return this.registry.list().map(({ configSchema, ...d }) => ({
      ...d,
      configFields: Object.keys((configSchema as { shape?: Record<string, unknown> }).shape ?? {}),
    }));
  }

  // ----------------------------------------------------------------- queries

  async list(
    organizationId: string,
    query: ListIntegrationsQuery,
  ): Promise<PaginatedResult<IntegrationView>> {
    const filters: SQL[] = [
      eq(integrations.organizationId, organizationId),
      isNull(integrations.deletedAt),
    ];
    if (query.category) filters.push(eq(integrations.category, query.category));
    if (query.status) filters.push(eq(integrations.status, query.status));
    if (query.provider) filters.push(eq(integrations.provider, query.provider));
    if (query.companyId) filters.push(eq(integrations.companyId, query.companyId));
    if (query.search) filters.push(sql`${integrations.name} ILIKE ${`%${query.search}%`}`);
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(integrations)
        .where(where)
        .orderBy(desc(integrations.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, integrations, where),
    ]);
    return toPaginatedResult(await this.toViews(rows), total, query);
  }

  async get(
    organizationId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<IntegrationView> {
    const row = await this.getRow(organizationId, id, executor);
    return (await this.toViews([row], executor))[0]!;
  }

  async getRow(
    organizationId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Integration> {
    const [row] = await executor
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.id, id),
          eq(integrations.organizationId, organizationId),
          isNull(integrations.deletedAt),
        ),
      );
    if (!row) throw new NotFoundError('Integration', id);
    return row;
  }

  /** Cross-tenant lookup for inbound webhooks (the URL carries the id; the signature authenticates). */
  async findAnyById(id: string, executor: DbExecutor = this.db): Promise<Integration | undefined> {
    const [row] = await executor
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), isNull(integrations.deletedAt)));
    return row;
  }

  // ----------------------------------------------------------------- writes

  async create(actor: AuthenticatedUser, input: CreateIntegrationInput): Promise<IntegrationView> {
    const connector = this.registry.get(input.provider);
    const config = this.validateConfig(connector, input.config);
    if (input.companyId && actor.companyId && input.companyId !== actor.companyId)
      throw new BusinessRuleError(
        ErrorCodes.COMPANY_NOT_ACCESSIBLE,
        'Company must match the active company.',
      );
    const id = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(
            eq(integrations.organizationId, actor.organizationId),
            eq(integrations.name, input.name),
            isNull(integrations.deletedAt),
          ),
        );
      if (existing) throw new DuplicateError('Integration', 'name', input.name);
      const [row] = await tx
        .insert(integrations)
        .values({
          organizationId: actor.organizationId,
          companyId: input.companyId ?? actor.companyId ?? null,
          provider: connector.descriptor.provider,
          category: connector.descriptor.category,
          name: input.name,
          authType: connector.descriptor.authType,
          config,
          capabilities: [...connector.descriptor.capabilities],
          syncSchedule: input.syncSchedule ?? null,
          createdBy: actor.id,
          status: 'DISCONNECTED',
        })
        .returning();
      if (input.scopes.length)
        await tx
          .insert(integrationScopes)
          .values(input.scopes.map((scope) => ({ integrationId: row!.id, scope })));
      const kinds = input.credentials
        ? await this.credentials.store(tx, row!.id, input.credentials)
        : [];
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Integration',
          entityId: row!.id,
          newValue: {
            name: input.name,
            provider: input.provider,
            scopes: input.scopes,
            credentialKinds: kinds,
          },
          companyId: row!.companyId,
        },
        tx,
      );
      return row!.id;
    });
    if (
      input.connect &&
      connector.descriptor.authType !== 'OAUTH2' &&
      connector.descriptor.authType !== 'OIDC'
    )
      await this.connect(actor, id).catch((err: unknown) => {
        this.logger.warn({ err, integrationId: id }, 'Initial connect failed');
      });
    return this.get(actor.organizationId, id);
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateIntegrationInput,
  ): Promise<IntegrationView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getRow(actor.organizationId, id, tx);
      const connector = this.registry.get(existing.provider);
      const config = input.config
        ? this.validateConfig(connector, { ...existing.config, ...input.config })
        : existing.config;
      await tx
        .update(integrations)
        .set({
          name: input.name ?? existing.name,
          config,
          syncSchedule:
            input.syncSchedule === undefined ? existing.syncSchedule : input.syncSchedule,
          status: input.status ?? existing.status,
        })
        .where(eq(integrations.id, id));
      if (input.scopes) {
        await tx.delete(integrationScopes).where(eq(integrationScopes.integrationId, id));
        if (input.scopes.length)
          await tx
            .insert(integrationScopes)
            .values(input.scopes.map((scope) => ({ integrationId: id, scope })));
      }
      const kinds = input.credentials
        ? await this.credentials.store(tx, id, input.credentials)
        : [];
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Integration',
          entityId: id,
          previousValue: {
            name: existing.name,
            status: existing.status,
            syncSchedule: existing.syncSchedule,
          },
          newValue: {
            name: input.name,
            status: input.status,
            syncSchedule: input.syncSchedule,
            scopes: input.scopes,
            configKeys: input.config ? Object.keys(input.config) : undefined,
            credentialKinds: kinds.length ? kinds : undefined,
          },
          companyId: existing.companyId,
        },
        tx,
      );
      if (kinds.length)
        await this.audit.record(
          {
            action: 'UPDATE',
            module: MODULE,
            entityType: 'IntegrationCredential',
            entityId: id,
            newValue: { kinds },
            companyId: existing.companyId,
          },
          tx,
        );
    });
    return this.get(actor.organizationId, id);
  }

  /** Soft delete: credentials are wiped immediately, the row stays for the trail. */
  async remove(actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getRow(actor.organizationId, id, tx);
      await this.credentials.remove(tx, id);
      await tx.delete(oauthConnections).where(eq(oauthConnections.integrationId, id));
      await tx
        .update(integrations)
        .set({
          deletedAt: new Date(),
          status: 'DISABLED',
          name: `${existing.name} (deleted ${new Date().toISOString().slice(0, 19)})`,
        })
        .where(eq(integrations.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Integration',
          entityId: id,
          previousValue: {
            name: existing.name,
            provider: existing.provider,
            status: existing.status,
          },
          companyId: existing.companyId,
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------- connection

  async connect(actor: AuthenticatedUser, id: string): Promise<IntegrationView> {
    const row = await this.getRow(actor.organizationId, id);
    if (row.status === 'DISABLED')
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'Enable the integration before connecting.',
      );
    await this.db.update(integrations).set({ status: 'CONNECTING' }).where(eq(integrations.id, id));
    const connector = this.registry.get(row.provider);
    const started = Date.now();
    try {
      const ctx = await this.context(row);
      const result = await connector.connect(ctx);
      if (!result.ok)
        throw new IntegrationError('AUTHENTICATION_ERROR', result.message ?? 'Connect failed.');
      await this.db.transaction(async (tx) => {
        if (result.secrets)
          await this.credentials.store(tx, id, result.secrets, result.credentialsExpireAt ?? null);
        await tx
          .update(integrations)
          .set({
            status: 'CONNECTED',
            connectedAt: new Date(),
            lastSuccessAt: new Date(),
            lastError: null,
            failureCount: 0,
          })
          .where(eq(integrations.id, id));
        await this.audit.record(
          {
            action: 'CONNECT',
            module: MODULE,
            entityType: 'Integration',
            entityId: id,
            newValue: { status: 'CONNECTED', externalAccountId: result.externalAccountId ?? null },
            companyId: row.companyId,
          },
          tx,
        );
      });
      await this.logs.record({
        organizationId: row.organizationId,
        integrationId: id,
        direction: 'OUTBOUND',
        operation: 'connect',
        status: 'SUCCESS',
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const ie = IntegrationError.from(err);
      await this.recordFailure(row, 'connect', ie, Date.now() - started, 'ERROR');
      throw new BusinessRuleError(ErrorCodes.INTEGRATION_ERROR, ie.message, { code: ie.code });
    }
    return this.get(actor.organizationId, id);
  }

  async disconnect(
    actor: AuthenticatedUser,
    id: string,
    reason?: string,
  ): Promise<IntegrationView> {
    const row = await this.getRow(actor.organizationId, id);
    const connector = this.registry.get(row.provider);
    try {
      await connector.disconnect(await this.context(row));
    } catch (err) {
      this.logger.warn(
        { err, integrationId: id },
        'Provider disconnect failed; continuing locally',
      );
    }
    await this.db.transaction(async (tx) => {
      await this.credentials.remove(tx, id);
      await tx
        .update(oauthConnections)
        .set({ status: 'REVOKED', revokedAt: new Date() })
        .where(eq(oauthConnections.integrationId, id));
      await tx
        .update(integrations)
        .set({ status: 'DISCONNECTED', nextSyncAt: null })
        .where(eq(integrations.id, id));
      await this.audit.record(
        {
          action: 'DISCONNECT',
          module: MODULE,
          entityType: 'Integration',
          entityId: id,
          previousValue: { status: row.status },
          newValue: { status: 'DISCONNECTED', reason: reason ?? null },
          companyId: row.companyId,
        },
        tx,
      );
    });
    await this.logs.record({
      organizationId: row.organizationId,
      integrationId: id,
      direction: 'OUTBOUND',
      operation: 'disconnect',
      status: 'SUCCESS',
    });
    return this.get(actor.organizationId, id);
  }

  async test(actor: AuthenticatedUser, id: string): Promise<TestConnectionResult> {
    const row = await this.getRow(actor.organizationId, id);
    const connector = this.registry.get(row.provider);
    const started = Date.now();
    try {
      const result = await connector.testConnection(await this.context(row));
      await this.logs.record({
        organizationId: row.organizationId,
        integrationId: id,
        direction: 'OUTBOUND',
        operation: 'test-connection',
        status: result.ok ? 'SUCCESS' : 'FAILURE',
        durationMs: result.latencyMs,
        message: result.message,
        metadata: result.details,
      });
      if (result.ok) await this.recordSuccess(id);
      else
        await this.recordFailure(
          row,
          'test-connection',
          new IntegrationError('PROVIDER_ERROR', result.message),
          result.latencyMs,
        );
      return result;
    } catch (err) {
      const ie = IntegrationError.from(err);
      await this.recordFailure(row, 'test-connection', ie, Date.now() - started);
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: ie.message,
        details: { code: ie.code },
      };
    }
  }

  // ----------------------------------------------------------------- context

  /** Builds the sandboxed context a connector call runs in (decrypted secrets live only here). */
  async context(row: Integration, executor: DbExecutor = this.db): Promise<ConnectorContext> {
    const connector = this.registry.get(row.provider);
    const secrets = await this.credentials.load(row.id, executor);
    const correlationId =
      RequestContext.get()?.correlationId ?? `int-${row.id.slice(0, 8)}-${Date.now()}`;
    const logs = this.logs;
    return {
      integration: row,
      organizationId: row.organizationId,
      companyId: row.companyId,
      config: row.config,
      secrets,
      correlationId,
      logger: {
        info: (data, message) =>
          this.logger.info({ ...data, integrationId: row.id, correlationId }, message),
        warn: (data, message) =>
          this.logger.warn({ ...data, integrationId: row.id, correlationId }, message),
      },
      http: createProviderHttp({
        provider: row.provider,
        rateLimitPerSecond: connector.descriptor.rateLimitPerSecond,
        throttle: this.throttle,
        defaultTimeoutMs: this.config.env.WEBHOOK_TIMEOUT_MS,
        onResponse: (info) =>
          void logs.record({
            organizationId: row.organizationId,
            integrationId: row.id,
            direction: 'OUTBOUND',
            operation: `http ${info.method}`,
            status: info.status >= 200 && info.status < 400 ? 'SUCCESS' : 'FAILURE',
            httpStatus: info.status || null,
            durationMs: info.durationMs,
            metadata: { url: info.url.split('?')[0] },
          }),
      }),
    };
  }

  connector(provider: string): IntegrationConnector {
    return this.registry.get(provider);
  }

  // ------------------------------------------------------------ bookkeeping

  async recordSuccess(id: string, executor: DbExecutor = this.db): Promise<void> {
    await executor
      .update(integrations)
      .set({
        lastSuccessAt: new Date(),
        failureCount: 0,
        lastError: null,
        status: sql`case when ${integrations.status} in ('ERROR','CONNECTING','SYNCING') then 'CONNECTED'::integration_status else ${integrations.status} end`,
      })
      .where(eq(integrations.id, id));
  }

  async recordFailure(
    row: Integration,
    operation: string,
    error: IntegrationError,
    durationMs?: number,
    status: IntegrationStatus | null = null,
    executor: DbExecutor = this.db,
  ): Promise<void> {
    const [updated] = await executor
      .update(integrations)
      .set({
        lastFailureAt: new Date(),
        lastError: `${error.code}: ${error.message}`.slice(0, 1000),
        failureCount: sql`${integrations.failureCount} + 1`,
        ...(status ? { status } : {}),
      })
      .where(eq(integrations.id, row.id))
      .returning({ failureCount: integrations.failureCount });
    await this.logs.record({
      organizationId: row.organizationId,
      integrationId: row.id,
      direction: 'OUTBOUND',
      operation,
      status: 'FAILURE',
      errorCode: error.code,
      httpStatus: error.options.httpStatus ?? null,
      durationMs: durationMs ?? null,
      message: error.message,
    });
    // Notify once the failure repeats (throttled per integration by the policy window).
    if ((updated?.failureCount ?? 0) >= 2 || status === 'ERROR') {
      await this.notifications.notify({
        organizationId: row.organizationId,
        eventType: 'INTEGRATION_FAILED',
        severity: 'ERROR',
        title: `Integration "${row.name}" is failing`,
        body: `${operation}: ${error.message}`,
        link: `/admin/integrations/${row.id}`,
        entityType: 'Integration',
        entityId: row.id,
        permission: 'integration.manage',
        companyId: row.companyId,
        dedupeKey: `integration-failed:${row.id}`,
      });
    }
  }

  // ----------------------------------------------------------------- helpers

  private validateConfig(
    connector: IntegrationConnector,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const parsed = connector.descriptor.configSchema.safeParse(config);
    if (!parsed.success)
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_CONFIG_INVALID,
        'The integration configuration is invalid.',
        {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      );
    return parsed.data as Record<string, unknown>;
  }

  private async toViews(
    rows: Integration[],
    executor: DbExecutor = this.db,
  ): Promise<IntegrationView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    // Sequential: the executor may be a transaction client, which cannot multiplex queries.
    const scopes = await executor
      .select()
      .from(integrationScopes)
      .where(inArray(integrationScopes.integrationId, ids));
    const oauth = await executor
      .select()
      .from(oauthConnections)
      .where(inArray(oauthConnections.integrationId, ids));
    const creds: Array<Awaited<ReturnType<CredentialsService['summary']>>> = [];
    for (const r of rows) creds.push(await this.credentials.summary(r.id, executor));
    return rows.map((r, i) => {
      const descriptor = this.registry.has(r.provider)
        ? this.registry.get(r.provider).descriptor
        : undefined;
      const conn = oauth.find((o) => o.integrationId === r.id);
      return {
        ...r,
        scopes: scopes
          .filter((s) => s.integrationId === r.id)
          .map((s) => s.scope)
          .sort(),
        providerName: descriptor?.name ?? r.provider,
        demo: descriptor?.demo ?? false,
        credentials: creds[i]!,
        oauth: conn
          ? {
              status: conn.status,
              accessExpiresAt: conn.accessExpiresAt,
              connectedAt: conn.connectedAt,
            }
          : null,
      };
    });
  }
}
