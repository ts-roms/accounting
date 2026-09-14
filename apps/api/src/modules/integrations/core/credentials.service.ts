import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { CredentialKind } from '@accounting/types';
import type { IntegrationCredentialsInput } from '@accounting/validation';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { integrationCredentials } from '@/database/schema';
import type { ConnectorSecrets } from './connector';
import { CredentialCipher } from './credential-cipher';

/**
 * The only component that sees plaintext secrets. Everything is encrypted with
 * AES-256-GCM before insert and decrypted only into a `ConnectorSecrets`
 * object that lives for one connector call. No method here returns anything
 * that a controller could serialise.
 */
@Injectable()
export class CredentialsService {
  readonly cipher: CredentialCipher;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CredentialsService.name);
    const secret = config.env.INTEGRATION_ENCRYPTION_KEY;
    if (!secret) {
      if (config.isProduction)
        throw new Error('INTEGRATION_ENCRYPTION_KEY must be set in production.');
      this.logger.warn(
        'INTEGRATION_ENCRYPTION_KEY not set - deriving a development key from JWT_ACCESS_SECRET',
      );
    }
    this.cipher = new CredentialCipher(secret ?? `dev:${config.env.JWT_ACCESS_SECRET}`);
  }

  /** Persists the supplied fields (each family in its own encrypted row). */
  async store(
    tx: DbExecutor,
    integrationId: string,
    input: IntegrationCredentialsInput | Partial<ConnectorSecrets>,
    expiresAt: Date | null = null,
  ): Promise<CredentialKind[]> {
    const rows: Array<{ kind: CredentialKind; value: unknown }> = [];
    if (input.apiKey) rows.push({ kind: 'API_KEY', value: { apiKey: input.apiKey } });
    if (input.username || input.password)
      rows.push({ kind: 'BASIC', value: { username: input.username, password: input.password } });
    if (input.bearerToken) rows.push({ kind: 'BEARER', value: { bearerToken: input.bearerToken } });
    if (input.hmacSecret)
      rows.push({ kind: 'HMAC_SECRET', value: { hmacSecret: input.hmacSecret } });
    if (input.webhookSecret)
      rows.push({ kind: 'WEBHOOK_SECRET', value: { webhookSecret: input.webhookSecret } });
    if ('oauth' in input && input.oauth) rows.push({ kind: 'OAUTH_TOKENS', value: input.oauth });
    for (const row of rows) {
      await tx
        .insert(integrationCredentials)
        .values({
          integrationId,
          kind: row.kind,
          ciphertext: this.cipher.encryptJson(row.value),
          keyVersion: this.cipher.keyVersion,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [integrationCredentials.integrationId, integrationCredentials.kind],
          set: {
            ciphertext: this.cipher.encryptJson(row.value),
            keyVersion: this.cipher.keyVersion,
            expiresAt,
            rotatedAt: new Date(),
          },
        });
    }
    return rows.map((r) => r.kind);
  }

  async remove(tx: DbExecutor, integrationId: string, kind?: CredentialKind): Promise<void> {
    await tx
      .delete(integrationCredentials)
      .where(
        kind
          ? and(
              eq(integrationCredentials.integrationId, integrationId),
              eq(integrationCredentials.kind, kind),
            )
          : eq(integrationCredentials.integrationId, integrationId),
      );
  }

  /** Decrypts every family into one object for a connector call. */
  async load(integrationId: string, executor: DbExecutor = this.db): Promise<ConnectorSecrets> {
    const rows = await executor
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, integrationId));
    const secrets: ConnectorSecrets = {};
    for (const row of rows) {
      const value = this.cipher.decryptJson<Record<string, string>>(row.ciphertext);
      switch (row.kind) {
        case 'API_KEY':
          secrets.apiKey = value.apiKey;
          break;
        case 'BASIC':
          secrets.username = value.username;
          secrets.password = value.password;
          break;
        case 'BEARER':
          secrets.bearerToken = value.bearerToken;
          break;
        case 'HMAC_SECRET':
          secrets.hmacSecret = value.hmacSecret;
          break;
        case 'WEBHOOK_SECRET':
          secrets.webhookSecret = value.webhookSecret;
          break;
        case 'OAUTH_TOKENS':
          secrets.oauth = value as unknown as ConnectorSecrets['oauth'];
          break;
      }
    }
    return secrets;
  }

  /** Metadata only (kinds, expiry) - safe to return to clients. */
  async summary(
    integrationId: string,
    executor: DbExecutor = this.db,
  ): Promise<Array<{ kind: CredentialKind; expiresAt: Date | null; rotatedAt: Date | null }>> {
    const rows = await executor
      .select({
        kind: integrationCredentials.kind,
        expiresAt: integrationCredentials.expiresAt,
        rotatedAt: integrationCredentials.rotatedAt,
      })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, integrationId));
    return rows;
  }

  /** Earliest credential expiry, for health scoring and expiry notifications. */
  async earliestExpiry(
    integrationId: string,
    executor: DbExecutor = this.db,
  ): Promise<Date | null> {
    const rows = await this.summary(integrationId, executor);
    const dates = rows.map((r) => r.expiresAt).filter((d): d is Date => Boolean(d));
    return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
  }
}
