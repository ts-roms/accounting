/* API response shapes for the integration platform and delegated authority (Prompt #4). */
import type {
  ApiKeyStatus,
  ConnectorCapability,
  DelegationApprovalPolicy,
  DelegationDecision,
  DelegationStatus,
  IntegrationAuthType,
  IntegrationCategory,
  IntegrationDirection,
  IntegrationEventStatus,
  IntegrationHealthStatus,
  IntegrationLogStatus,
  IntegrationStatus,
  NotificationEventType,
  NotificationSeverity,
  SyncEntity,
  SyncJobStatus,
  SyncMode,
  SyncTrigger,
  WebhookDeliveryStatus,
  WebhookSubscriptionStatus,
} from '@accounting/types';
import type { MappingFieldRuleInput } from '@accounting/validation';

export interface ProviderDescriptor {
  provider: string;
  category: IntegrationCategory;
  name: string;
  description: string;
  authType: IntegrationAuthType;
  capabilities: ConnectorCapability[];
  entities: string[];
  credentialFields: Array<{ key: string; label: string; required: boolean }>;
  configFields: string[];
  oauth?: { authorizeUrl: string; scopes: string[] };
  demo?: boolean;
}

export interface IntegrationView {
  id: string;
  organizationId: string;
  companyId: string | null;
  provider: string;
  providerName: string;
  demo: boolean;
  category: IntegrationCategory;
  name: string;
  status: IntegrationStatus;
  healthStatus: IntegrationHealthStatus;
  healthScore: number | null;
  authType: IntegrationAuthType;
  config: Record<string, unknown>;
  capabilities: ConnectorCapability[];
  syncSchedule: string | null;
  scopes: string[];
  credentials: Array<{ kind: string; expiresAt: string | null; rotatedAt: string | null }>;
  oauth: { status: string; accessExpiresAt: string | null; connectedAt: string | null } | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  failureCount: number;
  healthCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncJobView {
  id: string;
  integrationId: string;
  entity: string | null;
  direction: IntegrationDirection;
  mode: SyncMode;
  trigger: SyncTrigger;
  status: SyncJobStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsSkipped: number;
  recordsFailed: number;
  lastCursor: string | null;
  nextCursor: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  failures: Array<{ externalId: string | null; code: string; message: string }>;
  createdAt: string;
}

export interface IntegrationLogView {
  id: string;
  integrationId: string | null;
  direction: IntegrationDirection;
  requestId: string | null;
  correlationId: string | null;
  externalEventId: string | null;
  operation: string;
  status: IntegrationLogStatus;
  httpStatus: number | null;
  errorCode: string | null;
  durationMs: number | null;
  message: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface IntegrationHealthView {
  integrationId: string;
  score: number;
  status: IntegrationHealthStatus;
  deductions: Array<{ code: string; points: number; detail: string }>;
  connection: string;
  webhookHealth: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'NONE';
  credentialExpiry: { expiresAt: string | null; daysLeft: number | null; state: string };
  apiLatencyMs: number | null;
  rateLimitState: 'OK' | 'THROTTLED';
  checkedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  failureCount: number;
  nextSyncAt: string | null;
  lastSyncAt: string | null;
}

export interface IntegrationMappingView {
  id: string;
  entity: string;
  direction: IntegrationDirection;
  name: string;
  rules: MappingFieldRuleInput[];
  lookups: Record<string, Record<string, unknown>>;
  isActive: boolean;
  version: number;
  updatedAt: string;
}

export interface MappingsResponse {
  mappings: IntegrationMappingView[];
  defaults: Record<string, MappingFieldRuleInput[]>;
  outboundDefaults: Record<string, MappingFieldRuleInput[]>;
}

export interface MappingPreview {
  output: Record<string, unknown>;
  errors: Array<{ target: string; message: string }>;
  source: 'INTEGRATION' | 'CONNECTOR_DEFAULT' | 'NONE';
}

export interface ExternalReferenceView {
  id: string;
  entityType: string;
  externalId: string;
  internalId: string;
  lastSeenAt: string;
}

/** One provider's knowledge of an internal record (record-links endpoint). */
export interface RecordReferenceView {
  id: string;
  integrationId: string;
  integrationName: string;
  provider: string;
  providerName: string;
  integrationStatus: IntegrationStatus;
  entityType: string;
  externalId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  canPush: boolean;
  metadata: Record<string, unknown>;
  lastSeenAt: string;
  createdAt: string;
}

export interface PushTargetView {
  integrationId: string;
  integrationName: string;
  provider: string;
  providerName: string;
}

export interface RecordLinksView {
  references: RecordReferenceView[];
  pushTargets: PushTargetView[];
}

export interface PushRecordResult {
  integrationId: string;
  entity: SyncEntity;
  internalId: string;
  outcome: 'CREATED' | 'UPDATED' | 'FAILED';
  externalId: string | null;
  error: { code: string; message: string } | null;
}

export interface InboundEventView {
  id: string;
  eventType: string;
  externalEventId: string | null;
  status: IntegrationEventStatus;
  attempts: number;
  lastError: string | null;
  occurredAt: string;
  processedAt: string | null;
}

export interface ApiKeyView {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  ownerUserId: string;
  ownerName: string | null;
  status: ApiKeyStatus;
  effectiveStatus: ApiKeyStatus;
  scopes: string[];
  companyIds: string[];
  rateLimitPerMinute: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKeyView {
  secret: string;
}

export interface ScopeCatalogEntry {
  scope: string;
  description: string;
  permissions: string[];
}

export interface WebhookView {
  id: string;
  name: string;
  description: string | null;
  url: string;
  events: string[];
  companyId: string | null;
  integrationId: string | null;
  status: WebhookSubscriptionStatus;
  maxAttempts: number;
  failureCount: number;
  lastDeliveryAt: string | null;
  lastSuccessAt: string | null;
  disabledReason: string | null;
  pendingDeliveries: number;
  exhaustedDeliveries: number;
  createdAt: string;
}

export interface CreatedWebhook extends WebhookView {
  secret: string;
}

export interface WebhookDeliveryView {
  id: string;
  webhookId: string;
  webhookName: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  responseTimeMs: number | null;
  deliveredAt: string | null;
  replayOfId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationView {
  id: string;
  eventType: NotificationEventType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface DelegationScopeView {
  id: string;
  permission: string;
  branchId: string | null;
  branchCode: string | null;
  branchName: string | null;
  maxAmount: string | null;
  currency: string | null;
}

export interface DelegationView {
  id: string;
  delegationNumber: string;
  companyId: string;
  companyCode: string;
  companyName: string;
  delegatorUserId: string;
  delegatorName: string;
  delegatorEmail: string;
  delegateUserId: string;
  delegateName: string;
  delegateEmail: string;
  startAt: string;
  endAt: string;
  status: DelegationStatus;
  reason: string;
  requiredApprovals: number;
  approvedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  rejectionReason: string | null;
  usageCount: number;
  scopes: DelegationScopeView[];
  approvals: Array<{
    id: string;
    approverUserId: string;
    approverName: string | null;
    decision: DelegationDecision;
    comment: string | null;
    decidedAt: string;
  }>;
  canApprove: boolean;
  inEffect: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface DelegationUsageView {
  id: string;
  permission: string;
  action: string;
  documentType: string;
  documentId: string;
  documentNumber: string | null;
  amount: string | null;
  currency: string | null;
  delegateName: string | null;
  usedAt: string;
}

export interface DelegationPolicyView {
  approvalPolicy: DelegationApprovalPolicy;
  maxDurationDays: number;
  expiryWarningDays: number;
  revalidateAtUse: boolean;
}

export interface DelegablePermission {
  permission: string;
  label: string;
  area: string;
}
