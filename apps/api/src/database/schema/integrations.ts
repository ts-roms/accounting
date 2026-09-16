import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  API_KEY_STATUSES,
  CREDENTIAL_KINDS,
  INTEGRATION_AUTH_TYPES,
  INTEGRATION_CATEGORIES,
  INTEGRATION_DIRECTIONS,
  INTEGRATION_EVENT_STATUSES,
  INTEGRATION_HEALTH_STATUSES,
  INTEGRATION_LOG_STATUSES,
  INTEGRATION_STATUSES,
  NOTIFICATION_SEVERITIES,
  OAUTH_CONNECTION_STATUSES,
  SYNC_JOB_STATUSES,
  SYNC_MODES,
  SYNC_TRIGGERS,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { companies, organizations } from './organizations';
import { users } from './users';

/*
 * Integration platform (Prompt #4). The adapter layer between external
 * systems and the domain: nothing in these tables carries ledger amounts,
 * and none of them is read by the posting engine.
 */

export const integrationCategoryEnum = pgEnum('integration_category', INTEGRATION_CATEGORIES);
export const integrationStatusEnum = pgEnum('integration_status', INTEGRATION_STATUSES);
export const integrationHealthEnum = pgEnum('integration_health', INTEGRATION_HEALTH_STATUSES);
export const integrationAuthTypeEnum = pgEnum('integration_auth_type', INTEGRATION_AUTH_TYPES);
export const credentialKindEnum = pgEnum('credential_kind', CREDENTIAL_KINDS);
export const syncModeEnum = pgEnum('sync_mode', SYNC_MODES);
export const syncTriggerEnum = pgEnum('sync_trigger', SYNC_TRIGGERS);
export const syncJobStatusEnum = pgEnum('sync_job_status', SYNC_JOB_STATUSES);
export const integrationDirectionEnum = pgEnum('integration_direction', INTEGRATION_DIRECTIONS);
export const integrationLogStatusEnum = pgEnum('integration_log_status', INTEGRATION_LOG_STATUSES);
export const integrationEventStatusEnum = pgEnum(
  'integration_event_status',
  INTEGRATION_EVENT_STATUSES,
);
export const webhookSubscriptionStatusEnum = pgEnum(
  'webhook_subscription_status',
  WEBHOOK_SUBSCRIPTION_STATUSES,
);
export const webhookDeliveryStatusEnum = pgEnum(
  'webhook_delivery_status',
  WEBHOOK_DELIVERY_STATUSES,
);
export const oauthConnectionStatusEnum = pgEnum(
  'oauth_connection_status',
  OAUTH_CONNECTION_STATUSES,
);
export const apiKeyStatusEnum = pgEnum('api_key_status', API_KEY_STATUSES);
export const notificationSeverityEnum = pgEnum('notification_severity', NOTIFICATION_SEVERITIES);

// ----------------------------------------------------------------- registry

export const integrations = pgTable(
  'integrations',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Company the connector writes into; null for organization-level providers. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    category: integrationCategoryEnum('category').notNull(),
    name: text('name').notNull(),
    status: integrationStatusEnum('status').notNull().default('DISCONNECTED'),
    healthStatus: integrationHealthEnum('health_status').notNull().default('UNKNOWN'),
    healthScore: integer('health_score'),
    authType: integrationAuthTypeEnum('auth_type').notNull().default('NONE'),
    /** Non-secret configuration validated by the connector's own schema. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Snapshot of the connector's capabilities at registration. */
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    syncSchedule: text('sync_schedule'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Consecutive failures since the last success. */
    failureCount: integer('failure_count').notNull().default(0),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integrations_org_name_uq')
      .on(t.organizationId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index('integrations_org_status_idx').on(t.organizationId, t.status),
    index('integrations_next_sync_idx').on(t.nextSyncAt),
    check('integrations_health_score_chk', sql`${t.healthScore} BETWEEN 0 AND 100`),
  ],
);

/** Encrypted at rest (AES-256-GCM); never selected by list / detail endpoints. */
export const integrationCredentials = pgTable(
  'integration_credentials',
  {
    id: primaryId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    kind: credentialKindEnum('kind').notNull(),
    /** `v1:<iv>:<tag>:<ciphertext>` base64 segments. */
    ciphertext: text('ciphertext').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('integration_credentials_kind_uq').on(t.integrationId, t.kind)],
);

export const integrationScopes = pgTable(
  'integration_scopes',
  {
    id: primaryId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('integration_scopes_uq').on(t.integrationId, t.scope)],
);

// --------------------------------------------------------------------- sync

export const integrationSyncJobs = pgTable(
  'integration_sync_jobs',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    entity: text('entity'),
    /** INBOUND = pull + import; OUTBOUND = export + push. */
    direction: integrationDirectionEnum('direction').notNull().default('INBOUND'),
    mode: syncModeEnum('mode').notNull().default('INCREMENTAL'),
    trigger: syncTriggerEnum('trigger').notNull().default('MANUAL'),
    status: syncJobStatusEnum('status').notNull().default('QUEUED'),
    queueJobId: text('queue_job_id'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    resumedFromJobId: uuid('resumed_from_job_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    recordsProcessed: integer('records_processed').notNull().default(0),
    recordsCreated: integer('records_created').notNull().default(0),
    recordsUpdated: integer('records_updated').notNull().default(0),
    recordsSkipped: integer('records_skipped').notNull().default(0),
    recordsFailed: integer('records_failed').notNull().default(0),
    startCursor: text('start_cursor'),
    /** Checkpoint after the last committed batch: a resume starts here. */
    lastCursor: text('last_cursor'),
    nextCursor: text('next_cursor'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Per-record failures (bounded) for diagnosis. */
    failures: jsonb('failures')
      .$type<Array<{ externalId: string | null; code: string; message: string }>>()
      .notNull()
      .default([]),
    ...timestamps,
  },
  (t) => [
    index('integration_sync_jobs_integration_idx').on(t.integrationId, t.createdAt),
    index('integration_sync_jobs_status_idx').on(t.status),
  ],
);

export const integrationSyncCursors = pgTable(
  'integration_sync_cursors',
  {
    id: primaryId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    direction: integrationDirectionEnum('direction').notNull().default('INBOUND'),
    cursor: text('cursor'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /** Anything else the connector needs to resume (page token, watermark). */
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_sync_cursors_uq').on(t.integrationId, t.entity, t.direction),
  ],
);

// ------------------------------------------------------------------ mapping

export const integrationMappings = pgTable(
  'integration_mappings',
  {
    id: primaryId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    entity: text('entity').notNull(),
    direction: integrationDirectionEnum('direction').notNull().default('INBOUND'),
    name: text('name').notNull(),
    rules: jsonb('rules').$type<unknown[]>().notNull().default([]),
    lookups: jsonb('lookups')
      .$type<Record<string, Record<string, unknown>>>()
      .notNull()
      .default({}),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('integration_mappings_uq').on(t.integrationId, t.entity, t.direction)],
);

/** internal <-> external identity per integration; the guard against duplicate imports. */
export const integrationExternalReferences = pgTable(
  'integration_external_references',
  {
    id: primaryId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    entityType: text('entity_type').notNull(),
    externalId: text('external_id').notNull(),
    internalId: uuid('internal_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_external_refs_external_uq').on(
      t.integrationId,
      t.entityType,
      t.externalId,
    ),
    uniqueIndex('integration_external_refs_internal_uq').on(
      t.integrationId,
      t.entityType,
      t.internalId,
    ),
  ],
);

// --------------------------------------------------------------------- logs

export const integrationLogs = pgTable(
  'integration_logs',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'cascade',
    }),
    direction: integrationDirectionEnum('direction').notNull(),
    requestId: text('request_id'),
    correlationId: text('correlation_id'),
    externalEventId: text('external_event_id'),
    operation: text('operation').notNull(),
    status: integrationLogStatusEnum('status').notNull(),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms'),
    message: text('message'),
    /** Redacted request / response metadata - never credentials or tokens. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('integration_logs_integration_idx').on(t.integrationId, t.occurredAt),
    index('integration_logs_org_idx').on(t.organizationId, t.occurredAt),
  ],
);

// ------------------------------------------------------------------- events

/**
 * Outbox (OUTBOUND, written inside the business transaction) and received
 * webhooks (INBOUND, deduplicated by provider event id). Never deleted while a
 * delivery references them; a cleanup job prunes processed rows after 30 days.
 */
export const integrationEvents = pgTable(
  'integration_events',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'cascade',
    }),
    direction: integrationDirectionEnum('direction').notNull(),
    eventType: text('event_type').notNull(),
    externalEventId: text('external_event_id'),
    /** Idempotency of outbox writes (e.g. `journal.posted:<entryId>`). */
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: integrationEventStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    correlationId: text('correlation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_events_external_uq')
      .on(t.integrationId, t.externalEventId)
      .where(sql`${t.externalEventId} IS NOT NULL`),
    uniqueIndex('integration_events_dedupe_uq')
      .on(t.organizationId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index('integration_events_pending_idx').on(t.direction, t.status, t.occurredAt),
  ],
);

// ----------------------------------------------------------------- webhooks

export const integrationWebhooks = pgTable(
  'integration_webhooks',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    description: text('description'),
    url: text('url').notNull(),
    events: jsonb('events').$type<string[]>().notNull().default([]),
    /** Encrypted signing secret. */
    secretCiphertext: text('secret_ciphertext').notNull(),
    status: webhookSubscriptionStatusEnum('status').notNull().default('ACTIVE'),
    maxAttempts: integer('max_attempts').notNull().default(8),
    failureCount: integer('failure_count').notNull().default(0),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_webhooks_org_name_uq').on(t.organizationId, t.name),
    index('integration_webhooks_org_status_idx').on(t.organizationId, t.status),
  ],
);

export const integrationWebhookDeliveries = pgTable(
  'integration_webhook_deliveries',
  {
    id: primaryId(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => integrationWebhooks.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => integrationEvents.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    status: webhookDeliveryStatusEnum('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastHttpStatus: integer('last_http_status'),
    lastError: text('last_error'),
    responseTimeMs: integer('response_time_ms'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Set on manual replays (the original delivery stays for the trail). */
    replayOfId: uuid('replay_of_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('integration_webhook_deliveries_uq')
      .on(t.webhookId, t.eventId)
      .where(sql`${t.replayOfId} IS NULL`),
    index('integration_webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    index('integration_webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
  ],
);

// -------------------------------------------------------------------- OAuth

export const oauthConnections = pgTable(
  'oauth_connections',
  {
    id: primaryId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: oauthConnectionStatusEnum('status').notNull().default('PENDING'),
    /** SHA-256 of the pending `state`; cleared once the callback consumed it. */
    stateHash: text('state_hash'),
    stateExpiresAt: timestamp('state_expires_at', { withTimezone: true }),
    /** PKCE verifier is a secret: encrypted like tokens. */
    codeVerifierCiphertext: text('code_verifier_ciphertext'),
    redirectUri: text('redirect_uri'),
    returnTo: text('return_to'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    externalAccountId: text('external_account_id'),
    tokenType: text('token_type'),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    connectedBy: uuid('connected_by').references(() => users.id, { onDelete: 'set null' }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('oauth_connections_integration_uq').on(t.integrationId),
    index('oauth_connections_state_idx').on(t.stateHash),
  ],
);

// ----------------------------------------------------------------- API keys

export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    /** First characters of the secret (after the `ak_` prefix) for display and lookup. */
    prefix: text('prefix').notNull(),
    /** SHA-256 of the full secret; the plaintext is shown once and never stored. */
    keyHash: text('key_hash').notNull(),
    /** Authority ceiling: the key can never exceed this user's permissions. */
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: apiKeyStatusEnum('status').notNull().default('ACTIVE'),
    /** Empty = every company the owner can access. */
    companyIds: jsonb('company_ids').$type<string[]>().notNull().default([]),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(300),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokeReason: text('revoke_reason'),
    /** The key this one replaced (rotation chain). */
    rotatedFromId: uuid('rotated_from_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('api_keys_hash_uq').on(t.keyHash),
    index('api_keys_prefix_idx').on(t.prefix),
    index('api_keys_org_status_idx').on(t.organizationId, t.status),
  ],
);

export const apiKeyScopes = pgTable(
  'api_key_scopes',
  {
    id: primaryId(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKeys.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_key_scopes_uq').on(t.apiKeyId, t.scope)],
);

// -------------------------------------------------------------- idempotency

/** One row per (organization, Idempotency-Key). Concurrency-safe via the unique index. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    status: text('status').notNull().default('IN_PROGRESS'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_keys_uq').on(t.organizationId, t.idempotencyKey),
    index('idempotency_keys_expires_idx').on(t.expiresAt),
    check('idempotency_keys_status_chk', sql`${t.status} IN ('IN_PROGRESS', 'COMPLETED')`),
  ],
);

// ------------------------------------------------------------- notifications

export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    severity: notificationSeverityEnum('severity').notNull().default('INFO'),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** Throttle key: repeats within the policy window are suppressed. */
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt),
    index('notifications_dedupe_idx').on(t.userId, t.dedupeKey, t.createdAt),
  ],
);

export const notificationPolicies = pgTable(
  'notification_policies',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    throttleMinutes: integer('throttle_minutes').notNull().default(60),
    ...timestamps,
  },
  (t) => [uniqueIndex('notification_policies_uq').on(t.organizationId, t.eventType)],
);

export type Integration = typeof integrations.$inferSelect;
export type IntegrationCredential = typeof integrationCredentials.$inferSelect;
export type IntegrationSyncJob = typeof integrationSyncJobs.$inferSelect;
export type IntegrationSyncCursor = typeof integrationSyncCursors.$inferSelect;
export type IntegrationMapping = typeof integrationMappings.$inferSelect;
export type IntegrationExternalReference = typeof integrationExternalReferences.$inferSelect;
export type IntegrationLog = typeof integrationLogs.$inferSelect;
export type IntegrationEvent = typeof integrationEvents.$inferSelect;
export type IntegrationWebhook = typeof integrationWebhooks.$inferSelect;
export type IntegrationWebhookDelivery = typeof integrationWebhookDeliveries.$inferSelect;
export type OAuthConnection = typeof oauthConnections.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NotificationPolicy = typeof notificationPolicies.$inferSelect;
