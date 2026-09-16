import type { ZodType } from 'zod';
import { z } from 'zod';
import type {
  ConnectorCapability,
  InboundEventType,
  IntegrationAuthType,
  IntegrationCategory,
  SyncEntity,
} from '@accounting/types';
import type { MappingFieldRuleInput } from '@accounting/validation';
import type { Integration } from '@/database/schema';

/**
 * Connector contract. One implementation per external provider; the platform
 * (registry, sync engine, webhooks, OAuth) only ever talks to this interface,
 * so adding a provider never touches an accounting module.
 *
 * A connector returns *external records*; it never writes to the domain. The
 * sync engine maps them and hands them to importers, which call the real
 * domain services (CustomersService, InvoicesService, ...). That is what keeps
 * the ledger behind AccountingPostingService.
 */

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: readonly string[];
  /** PKCE (S256) is used whenever the provider supports it. */
  pkce?: boolean;
  /** Extra query parameters on the authorisation URL (e.g. access_type=offline). */
  extraAuthorizeParams?: Record<string, string>;
}

export interface ConnectorDescriptor {
  provider: string;
  category: IntegrationCategory;
  name: string;
  description: string;
  authType: IntegrationAuthType;
  capabilities: readonly ConnectorCapability[];
  /** Entities `pull` supports, in the order a full sync runs them. */
  entities: readonly SyncEntity[];
  /** Validates the non-secret `config` an administrator supplies. */
  configSchema: ZodType;
  /** Which credential fields the UI should ask for. */
  credentialFields: ReadonlyArray<{
    key: 'apiKey' | 'username' | 'password' | 'bearerToken' | 'hmacSecret' | 'webhookSecret';
    label: string;
    required: boolean;
  }>;
  /** Default inbound field mappings per entity (overridable per integration). */
  defaultMappings?: Partial<Record<SyncEntity, MappingFieldRuleInput[]>>;
  /** Default outbound field mappings per entity (internal view -> provider payload); identity when absent. */
  defaultOutboundMappings?: Partial<Record<SyncEntity, MappingFieldRuleInput[]>>;
  oauth?: OAuthProviderConfig;
  /** Provider rate limit the outbound client honours (requests per second). */
  rateLimitPerSecond?: number;
  /** Whether webhooks from this provider carry a timestamped signature (see webhook-signature.ts). */
  webhookSignature?: 'TIMESTAMPED' | 'PLAIN_HMAC' | 'NONE';
  /** Demo / mock connectors are listed under "Available" but flagged so they are never mistaken for real providers. */
  demo?: boolean;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  tokenType?: string;
  scope?: string;
  externalAccountId?: string;
}

/** Decrypted secrets handed to the connector for the duration of one call. */
export interface ConnectorSecrets {
  apiKey?: string;
  username?: string;
  password?: string;
  bearerToken?: string;
  hmacSecret?: string;
  webhookSecret?: string;
  oauth?: { accessToken: string; refreshToken?: string; expiresAt?: string; tokenType?: string };
}

export interface ConnectorLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface ConnectorContext {
  integration: Integration;
  organizationId: string;
  companyId: string | null;
  config: Record<string, unknown>;
  secrets: ConnectorSecrets;
  logger: ConnectorLogger;
  /** Throttled fetch honouring the provider's rate limit; never logs bodies. */
  http: (input: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;
  correlationId: string;
}

export interface ConnectResult {
  ok: boolean;
  message?: string;
  externalAccountId?: string;
  /** Rotated / issued credentials the platform should persist (encrypted). */
  secrets?: Partial<ConnectorSecrets>;
  credentialsExpireAt?: Date | null;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface PullRequest {
  entity: SyncEntity;
  /** Opaque checkpoint from the last committed batch; undefined for a full sync. */
  cursor?: string | null;
  /** Batch size hint. */
  limit: number;
  mode: 'INCREMENTAL' | 'FULL';
}

export interface ExternalRecord {
  externalId: string;
  /** Raw provider payload; the mapping engine turns it into a domain input. */
  data: Record<string, unknown>;
  /** Provider timestamp when known (drives incremental cursors). */
  updatedAt?: string;
}

export interface PullResult {
  records: ExternalRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** One batch of mapped internal records to send to the provider. */
export interface PushRequest {
  entity: SyncEntity;
  records: Array<{
    internalId: string;
    /** Provider id from an earlier push of the same record (update instead of create). */
    externalId: string | null;
    data: Record<string, unknown>;
  }>;
}

export interface PushResult {
  results: Array<{
    internalId: string;
    /** Provider id to remember for the record; null when the provider issues none. */
    externalId: string | null;
    ok: boolean;
    /** Record-level rejection (validation, business rule); transport errors are thrown instead. */
    error?: string;
    /** Anything worth keeping next to the reference (receipt, acknowledgement, status). */
    metadata?: Record<string, unknown>;
  }>;
}

/** A verified inbound webhook, normalised by the connector. */
export interface InboundWebhookEvent {
  eventId: string;
  eventType: InboundEventType | string;
  occurredAt?: string;
  payload: Record<string, unknown>;
}

export interface WebhookVerification {
  ok: boolean;
  reason?: string;
  event?: InboundWebhookEvent;
}

/** What the platform should do with a verified inbound event. */
export interface WebhookHandling {
  /** Records to run through mapping + importers (same path as a sync). */
  imports: Array<{ entity: SyncEntity; record: ExternalRecord }>;
  /** Trigger an incremental sync of these entities instead of / in addition to direct imports. */
  syncEntities?: SyncEntity[];
  note?: string;
}

export interface IntegrationConnector {
  readonly descriptor: ConnectorDescriptor;
  connect(ctx: ConnectorContext): Promise<ConnectResult>;
  disconnect(ctx: ConnectorContext): Promise<void>;
  testConnection(ctx: ConnectorContext): Promise<TestConnectionResult>;
  pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult>;
  push?(ctx: ConnectorContext, req: PushRequest): Promise<PushResult>;
  /** Verifies the signature and normalises the event. `rawBody` is the exact bytes received. */
  verifyWebhook?(
    ctx: ConnectorContext,
    input: { headers: Record<string, string | undefined>; rawBody: string; body: unknown },
  ): Promise<WebhookVerification>;
  handleWebhook?(ctx: ConnectorContext, event: InboundWebhookEvent): Promise<WebhookHandling>;
  /** Exchanges / refreshes credentials (OAuth refresh, key rotation). */
  refreshCredentials?(ctx: ConnectorContext): Promise<Partial<ConnectorSecrets> | null>;
  /**
   * OAuth overrides for providers that do not speak the standard token
   * endpoint (or for mocks). When absent the platform posts to
   * `descriptor.oauth.tokenUrl` with the client credentials.
   */
  exchangeAuthorizationCode?(
    ctx: ConnectorContext,
    input: { code: string; redirectUri: string; codeVerifier?: string },
  ): Promise<OAuthTokens>;
  refreshAccessToken?(ctx: ConnectorContext, refreshToken: string): Promise<OAuthTokens>;
  revokeTokens?(ctx: ConnectorContext): Promise<void>;
  getCapabilities(): readonly ConnectorCapability[];
}

/** Convenience base so connectors implement only what they support. */
export abstract class BaseConnector implements IntegrationConnector {
  abstract readonly descriptor: ConnectorDescriptor;

  getCapabilities(): readonly ConnectorCapability[] {
    return this.descriptor.capabilities;
  }

  async connect(_ctx: ConnectorContext): Promise<ConnectResult> {
    return { ok: true };
  }

  async disconnect(_ctx: ConnectorContext): Promise<void> {
    /* nothing to revoke by default */
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const started = Date.now();
    const result = await this.connect(ctx);
    return {
      ok: result.ok,
      latencyMs: Date.now() - started,
      message: result.message ?? (result.ok ? 'Connection OK' : 'Connection failed'),
    };
  }

  async pull(_ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    throw new Error(`${this.descriptor.provider} cannot pull ${req.entity}.`);
  }
}

/**
 * Config keys every PUSH-capable connector should spread into its configSchema:
 * `pushOnEvents` lets an operator turn event-driven pushes off (default on) - the
 * platform only reads keys the schema kept.
 */
export const pushConfigSchema = {
  pushOnEvents: z.boolean().default(true),
};
