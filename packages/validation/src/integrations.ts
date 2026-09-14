/* Integration platform: registry, credentials, API keys, webhooks, sync, mapping (Prompt #4). */
import { z } from 'zod';
import {
  API_SCOPES,
  INTEGRATION_CATEGORIES,
  INTEGRATION_DIRECTIONS,
  INTEGRATION_LOG_STATUSES,
  INTEGRATION_STATUSES,
  OUTBOUND_EVENT_TYPES,
  SYNC_ENTITIES,
  SYNC_JOB_STATUSES,
  SYNC_MODES,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_SUBSCRIPTION_STATUSES,
} from '@accounting/types';
import { nameSchema, optionalText, paginationQuerySchema, uuidSchema } from './primitives';

// ----------------------------------------------------------------- registry

/** Provider key such as DEMO_BANK; connectors register under these keys. */
export const providerKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z0-9][A-Z0-9_]*$/, 'Provider keys are uppercase with underscores');

/** Free-form but bounded: connectors validate the shape they need with their own schema. */
export const integrationConfigSchema = z.record(z.string().max(64), z.unknown()).default({});

/**
 * Secrets arrive only here and only over TLS; they are encrypted before they
 * touch the database and never returned by any endpoint.
 */
export const integrationCredentialsInputSchema = z
  .object({
    apiKey: z.string().min(1).max(4096).optional(),
    username: z.string().min(1).max(255).optional(),
    password: z.string().min(1).max(4096).optional(),
    bearerToken: z.string().min(1).max(8192).optional(),
    hmacSecret: z.string().min(8).max(4096).optional(),
    webhookSecret: z.string().min(8).max(4096).optional(),
  })
  .strict();
export type IntegrationCredentialsInput = z.infer<typeof integrationCredentialsInputSchema>;

export const createIntegrationSchema = z.object({
  provider: providerKeySchema,
  name: nameSchema,
  /** Company the integration writes into; null = organization-level (identity, storage...). */
  companyId: uuidSchema.nullable().optional(),
  config: integrationConfigSchema,
  scopes: z.array(z.enum(API_SCOPES)).max(50).default([]),
  credentials: integrationCredentialsInputSchema.optional(),
  /** Cron expression (5 fields) for scheduled sync; null disables scheduling. */
  syncSchedule: z
    .string()
    .trim()
    .regex(/^(\S+\s+){4}\S+$/, 'Use a 5-field cron expression')
    .nullable()
    .optional(),
  /** Connect immediately after creation (runs the connector's connect + test). */
  connect: z.boolean().default(true),
});
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z.object({
  name: nameSchema.optional(),
  config: integrationConfigSchema.optional(),
  scopes: z.array(z.enum(API_SCOPES)).max(50).optional(),
  credentials: integrationCredentialsInputSchema.optional(),
  syncSchedule: createIntegrationSchema.shape.syncSchedule,
  status: z.enum(['DISABLED', 'DISCONNECTED']).optional(),
});
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

export const listIntegrationsQuerySchema = paginationQuerySchema.extend({
  category: z.enum(INTEGRATION_CATEGORIES).optional(),
  status: z.enum(INTEGRATION_STATUSES).optional(),
  provider: providerKeySchema.optional(),
  companyId: uuidSchema.optional(),
});
export type ListIntegrationsQuery = z.infer<typeof listIntegrationsQuerySchema>;

// --------------------------------------------------------------------- sync

export const triggerSyncSchema = z.object({
  entity: z.enum(SYNC_ENTITIES).optional(),
  mode: z.enum(SYNC_MODES).default('INCREMENTAL'),
  /** Resume from the checkpoint of a failed / paused job instead of the stored cursor. */
  resumeJobId: uuidSchema.optional(),
});
export type TriggerSyncInput = z.infer<typeof triggerSyncSchema>;

export const listSyncJobsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SYNC_JOB_STATUSES).optional(),
  entity: z.enum(SYNC_ENTITIES).optional(),
});
export type ListSyncJobsQuery = z.infer<typeof listSyncJobsQuerySchema>;

// ------------------------------------------------------------------ mapping

export const MAPPING_TRANSFORMS = [
  'trim',
  'upper',
  'lower',
  'toString',
  'toNumber',
  'toDecimal',
  'toInteger',
  'toBoolean',
  'toDate',
  'negate',
  'abs',
  'multiply',
  'divide',
  'template',
  'lookup',
  'default',
  'convertCurrency',
  'mapEach',
  'first',
  'count',
] as const;
export type MappingTransformName = (typeof MAPPING_TRANSFORMS)[number];

export const mappingTransformSchema = z.object({
  name: z.enum(MAPPING_TRANSFORMS),
  /** Transform argument: scale for toDecimal, factor for multiply, template string, lookup table name, ... */
  arg: z.unknown().optional(),
});
export type MappingTransform = z.infer<typeof mappingTransformSchema>;

export const MAPPING_CONDITION_OPERATORS = [
  'eq',
  'ne',
  'in',
  'notIn',
  'exists',
  'missing',
  'gt',
  'gte',
  'lt',
  'lte',
  'matches',
] as const;

export const mappingConditionSchema = z.object({
  path: z.string().trim().min(1).max(200),
  op: z.enum(MAPPING_CONDITION_OPERATORS),
  value: z.unknown().optional(),
});
export type MappingCondition = z.infer<typeof mappingConditionSchema>;

/** One target field: where it comes from, what to do with it, when it applies. */
export const mappingFieldRuleSchema = z.object({
  target: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(200).optional(),
  /** Literal used when the source is missing (after transforms run on the literal too). */
  default: z.unknown().optional(),
  transforms: z.array(mappingTransformSchema).max(20).default([]),
  when: mappingConditionSchema.optional(),
  required: z.boolean().default(false),
});
export type MappingFieldRule = z.infer<typeof mappingFieldRuleSchema>;
/** Authoring shape (defaults optional) used by connector default mappings. */
export type MappingFieldRuleInput = z.input<typeof mappingFieldRuleSchema>;

export const upsertMappingSchema = z.object({
  entity: z.enum(SYNC_ENTITIES),
  direction: z.enum(INTEGRATION_DIRECTIONS).default('INBOUND'),
  name: nameSchema,
  rules: z.array(mappingFieldRuleSchema).min(1).max(200),
  /** Named lookup tables usable by `lookup` transforms: { status: { paid: 'PAID' } }. */
  lookups: z.record(z.string().max(64), z.record(z.string().max(200), z.unknown())).default({}),
  isActive: z.boolean().default(true),
});
export type UpsertMappingInput = z.infer<typeof upsertMappingSchema>;

export const previewMappingSchema = z.object({
  entity: z.enum(SYNC_ENTITIES),
  direction: z.enum(INTEGRATION_DIRECTIONS).default('INBOUND'),
  sample: z.record(z.string(), z.unknown()),
});
export type PreviewMappingInput = z.infer<typeof previewMappingSchema>;

// --------------------------------------------------------------------- logs

export const listIntegrationLogsQuerySchema = paginationQuerySchema.extend({
  integrationId: uuidSchema.optional(),
  direction: z.enum(INTEGRATION_DIRECTIONS).optional(),
  status: z.enum(INTEGRATION_LOG_STATUSES).optional(),
  operation: z.string().trim().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export type ListIntegrationLogsQuery = z.infer<typeof listIntegrationLogsQuerySchema>;

// ----------------------------------------------------------------- API keys

export const createApiKeySchema = z.object({
  name: nameSchema,
  description: optionalText(500),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'Pick at least one scope').max(50),
  /** Companies the key may act in; empty = every company the owner can access. */
  companyIds: z.array(uuidSchema).max(50).default([]),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(10000).default(300),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const rotateApiKeySchema = z.object({
  /** Grace period during which the previous secret keeps working (0 = immediate). */
  graceMinutes: z.coerce.number().int().min(0).max(24 * 60).default(0),
});
export type RotateApiKeyInput = z.infer<typeof rotateApiKeySchema>;

// ----------------------------------------------------------------- webhooks

export const httpsUrlSchema = z
  .url({ message: 'Must be an absolute URL' })
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are accepted');

export const createWebhookSchema = z.object({
  name: nameSchema,
  url: httpsUrlSchema,
  events: z.array(z.enum(OUTBOUND_EVENT_TYPES)).min(1, 'Pick at least one event').max(50),
  /** Restrict to one company; null = every company in the organization. */
  companyId: uuidSchema.nullable().optional(),
  /** Optional link to an integration (deliveries then count toward its health). */
  integrationId: uuidSchema.nullable().optional(),
  description: optionalText(500),
  /** Signing secret; generated when omitted and shown once. */
  secret: z.string().min(16).max(256).optional(),
  maxAttempts: z.coerce.number().int().min(1).max(20).default(8),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  name: nameSchema.optional(),
  url: httpsUrlSchema.optional(),
  events: z.array(z.enum(OUTBOUND_EVENT_TYPES)).min(1).max(50).optional(),
  description: optionalText(500),
  status: z.enum(WEBHOOK_SUBSCRIPTION_STATUSES).optional(),
  maxAttempts: z.coerce.number().int().min(1).max(20).optional(),
});
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export const listWebhookDeliveriesQuerySchema = paginationQuerySchema.extend({
  webhookId: uuidSchema.optional(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
  eventType: z.enum(OUTBOUND_EVENT_TYPES).optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;

export const replayWebhookSchema = z.object({
  /** Replay these deliveries; omit to replay every FAILED / EXHAUSTED delivery of the webhook. */
  deliveryIds: z.array(uuidSchema).max(100).optional(),
});
export type ReplayWebhookInput = z.infer<typeof replayWebhookSchema>;

// -------------------------------------------------------------------- OAuth

export const oauthStartSchema = z.object({
  /** Where the browser is sent after the callback completes (must be same-origin in production). */
  returnTo: z.string().trim().max(2048).optional(),
});
export type OAuthStartInput = z.infer<typeof oauthStartSchema>;

export const oauthCallbackSchema = z.object({
  state: z.string().trim().min(16).max(512),
  code: z.string().trim().min(1).max(4096).optional(),
  error: z.string().trim().max(200).optional(),
  error_description: z.string().trim().max(1000).optional(),
});
export type OAuthCallbackInput = z.infer<typeof oauthCallbackSchema>;

// ------------------------------------------------------------- notifications

export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  unreadOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationPolicySchema = z.object({
  enabled: z.boolean().default(true),
  /** Suppress repeats of the same event key for this many minutes. */
  throttleMinutes: z.coerce.number().int().min(0).max(24 * 60).default(60),
});
export type NotificationPolicyInput = z.infer<typeof notificationPolicySchema>;
