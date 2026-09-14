import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { ApiKeyStatus } from '@accounting/types';
import type { CreateApiKeyInput, RotateApiKeyInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError, UnauthenticatedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { apiKeyScopes, apiKeys, users, type ApiKey } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';
import {
  apiKeyState,
  FixedWindowRateLimiter,
  generateApiKey,
  grantableScopes,
  hashApiKey,
} from './api-key.logic';

const MODULE = 'INTEGRATIONS';

export interface ApiKeyView extends Omit<ApiKey, 'keyHash'> {
  scopes: string[];
  ownerName: string | null;
  /** Derived: expiry is evaluated at read time so the list never shows a stale ACTIVE. */
  effectiveStatus: ApiKeyStatus;
}

export interface CreatedApiKey extends ApiKeyView {
  /** Shown exactly once. */
  secret: string;
}

/** A key that passed authentication, with its scopes. */
export interface AuthenticatedApiKey {
  key: ApiKey;
  scopes: string[];
}

/**
 * Internal API keys. The secret is shown once; only its hash is stored. A key
 * carries scopes, never roles, and its authority is capped by its owner's.
 */
@Injectable()
export class ApiKeysService {
  private readonly limiter = new FixedWindowRateLimiter();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly resolver: PermissionResolverService,
  ) {}

  async list(organizationId: string): Promise<ApiKeyView[]> {
    const rows = await this.viewQuery()
      .where(eq(apiKeys.organizationId, organizationId))
      .orderBy(desc(apiKeys.createdAt));
    return this.withScopes(rows);
  }

  async get(organizationId: string, id: string): Promise<ApiKeyView> {
    const [row] = await this.viewQuery().where(
      and(eq(apiKeys.id, id), eq(apiKeys.organizationId, organizationId)),
    );
    if (!row) throw new NotFoundError('API key', id);
    return (await this.withScopes([row]))[0]!;
  }

  async create(actor: AuthenticatedUser, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    // Rule: a key cannot carry authority its creator does not hold (organization-wide view).
    const ownerAccess = await this.resolver.resolve(actor.id, input.companyIds[0]);
    const { allowed, denied } = grantableScopes(input.scopes, ownerAccess.permissions);
    if (denied.length > 0)
      throw new BusinessRuleError(
        ErrorCodes.SCOPE_NOT_GRANTABLE,
        'You can only grant scopes covered by your own permissions.',
        { denied },
      );
    const generated = generateApiKey();
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({
          organizationId: actor.organizationId,
          name: input.name,
          description: input.description ?? null,
          prefix: generated.prefix,
          keyHash: generated.hash,
          ownerUserId: actor.id,
          companyIds: input.companyIds,
          rateLimitPerMinute: input.rateLimitPerMinute,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdBy: actor.id,
        })
        .returning({ id: apiKeys.id });
      await tx.insert(apiKeyScopes).values(allowed.map((scope) => ({ apiKeyId: row!.id, scope })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ApiKey',
          entityId: row!.id,
          newValue: {
            name: input.name,
            prefix: generated.prefix,
            scopes: allowed,
            companyIds: input.companyIds,
            expiresAt: input.expiresAt ?? null,
          },
        },
        tx,
      );
      return row!.id;
    });
    const view = await this.get(actor.organizationId, id);
    return { ...view, secret: generated.secret };
  }

  /** Issues a replacement secret; the old one keeps working for `graceMinutes`. */
  async rotate(
    actor: AuthenticatedUser,
    id: string,
    input: RotateApiKeyInput,
  ): Promise<CreatedApiKey> {
    const existing = await this.get(actor.organizationId, id);
    if (existing.effectiveStatus !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        `Only active keys can be rotated (this one is ${existing.effectiveStatus.toLowerCase()}).`,
      );
    const generated = generateApiKey();
    const newId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(apiKeys)
        .values({
          organizationId: existing.organizationId,
          name: existing.name,
          description: existing.description,
          prefix: generated.prefix,
          keyHash: generated.hash,
          ownerUserId: existing.ownerUserId,
          companyIds: existing.companyIds,
          rateLimitPerMinute: existing.rateLimitPerMinute,
          expiresAt: existing.expiresAt,
          rotatedFromId: existing.id,
          createdBy: actor.id,
        })
        .returning({ id: apiKeys.id });
      await tx
        .insert(apiKeyScopes)
        .values(existing.scopes.map((scope) => ({ apiKeyId: row!.id, scope })));
      const graceEnd = new Date(Date.now() + input.graceMinutes * 60_000);
      await tx
        .update(apiKeys)
        .set(
          input.graceMinutes > 0
            ? { expiresAt: graceEnd }
            : {
                status: 'REVOKED',
                revokedAt: new Date(),
                revokedBy: actor.id,
                revokeReason: 'ROTATED',
              },
        )
        .where(eq(apiKeys.id, existing.id));
      await this.audit.record(
        {
          action: 'ROTATE',
          module: MODULE,
          entityType: 'ApiKey',
          entityId: existing.id,
          newValue: { replacedBy: row!.id, graceMinutes: input.graceMinutes },
        },
        tx,
      );
      return row!.id;
    });
    const view = await this.get(actor.organizationId, newId);
    return { ...view, secret: generated.secret };
  }

  async revoke(actor: AuthenticatedUser, id: string, reason?: string): Promise<ApiKeyView> {
    const existing = await this.get(actor.organizationId, id);
    if (existing.effectiveStatus === 'REVOKED') return existing;
    await this.db.transaction(async (tx) => {
      await tx
        .update(apiKeys)
        .set({
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedBy: actor.id,
          revokeReason: reason ?? null,
        })
        .where(eq(apiKeys.id, id));
      await this.audit.record(
        {
          action: 'REVOKE',
          module: MODULE,
          entityType: 'ApiKey',
          entityId: id,
          previousValue: { status: existing.effectiveStatus },
          newValue: { status: 'REVOKED', reason: reason ?? null },
        },
        tx,
      );
    });
    return this.get(actor.organizationId, id);
  }

  // ---------------------------------------------------------- authentication

  /**
   * Resolves a presented secret. Distinct error codes let clients tell an
   * expired key from a revoked one, but neither reveals whether the prefix
   * exists.
   */
  async authenticate(secret: string): Promise<AuthenticatedApiKey> {
    const hash = hashApiKey(secret);
    const [key] = await this.db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
    if (!key) throw new UnauthenticatedError('Invalid API key.', ErrorCodes.API_KEY_INVALID);
    const state = apiKeyState(key);
    if (state === 'REVOKED')
      throw new UnauthenticatedError('This API key has been revoked.', ErrorCodes.API_KEY_REVOKED);
    if (state === 'EXPIRED')
      throw new UnauthenticatedError('This API key has expired.', ErrorCodes.API_KEY_EXPIRED);
    const scopes = await this.db
      .select({ scope: apiKeyScopes.scope })
      .from(apiKeyScopes)
      .where(eq(apiKeyScopes.apiKeyId, key.id));
    return { key, scopes: scopes.map((s) => s.scope) };
  }

  /** Returns remaining quota, or -1 when the key exceeded its per-minute limit. */
  consumeQuota(key: ApiKey): number {
    return this.limiter.hit(key.id, key.rateLimitPerMinute);
  }

  /** Records usage at most once a minute per key (cheap, never on the request path). */
  touch(keyId: string): void {
    const now = Date.now();
    const last = this.lastTouched.get(keyId) ?? 0;
    if (now - last < 60_000) return;
    this.lastTouched.set(keyId, now);
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, keyId))
      .catch(() => undefined);
  }

  /** Marks keys past their expiry (cleanup job) so lists and audits reflect it. */
  async expireDue(executor: DbExecutor = this.db): Promise<number> {
    const rows = await executor
      .update(apiKeys)
      .set({ status: 'EXPIRED' })
      .where(and(eq(apiKeys.status, 'ACTIVE'), sql`${apiKeys.expiresAt} <= now()`))
      .returning({ id: apiKeys.id });
    return rows.length;
  }

  // ----------------------------------------------------------------- helpers

  private viewQuery() {
    const { keyHash: _hash, ...columns } = getTableColumns(apiKeys);
    return this.db
      .select({
        ...columns,
        ownerName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.ownerUserId));
  }

  private async withScopes(rows: Array<Omit<ApiKey, 'keyHash'> & { ownerName: string | null }>) {
    if (rows.length === 0) return [];
    const scopes = await this.db
      .select()
      .from(apiKeyScopes)
      .where(
        inArray(
          apiKeyScopes.apiKeyId,
          rows.map((r) => r.id),
        ),
      );
    return rows.map<ApiKeyView>((r) => ({
      ...r,
      scopes: scopes
        .filter((s) => s.apiKeyId === r.id)
        .map((s) => s.scope)
        .sort(),
      effectiveStatus: apiKeyState(r),
    }));
  }
}
