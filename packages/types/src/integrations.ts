/**
 * Integration platform (Prompt #4): connectors, credentials, API keys, OAuth,
 * webhooks, sync engine, mapping, logs and health. Everything here is a data
 * enum shared by the API, the validation schemas and the web client.
 */
import type { PermissionKey } from './permissions';

// ----------------------------------------------------------------- registry

export const INTEGRATION_CATEGORIES = [
  'BANKING',
  'PAYMENT',
  'ECOMMERCE',
  'PROCUREMENT',
  'TAX',
  'PAYROLL',
  'CRM',
  'STORAGE',
  'COMMUNICATION',
  'IDENTITY',
  'ANALYTICS',
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_STATUSES = [
  'CONNECTED',
  'DISCONNECTED',
  'CONNECTING',
  'SYNCING',
  'ERROR',
  'DISABLED',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_HEALTH_STATUSES = ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN'] as const;
export type IntegrationHealthStatus = (typeof INTEGRATION_HEALTH_STATUSES)[number];

export const INTEGRATION_AUTH_TYPES = [
  'NONE',
  'API_KEY',
  'OAUTH2',
  'OIDC',
  'BASIC',
  'HMAC',
  'BEARER',
] as const;
export type IntegrationAuthType = (typeof INTEGRATION_AUTH_TYPES)[number];

/** What a connector can do; the registry snapshots this on the integration row. */
export const CONNECTOR_CAPABILITIES = [
  'PULL',
  'PUSH',
  'WEBHOOKS',
  'INCREMENTAL_SYNC',
  'TEST_CONNECTION',
  'REFRESH_CREDENTIALS',
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

/** Encrypted credential families kept in `integration_credentials`. */
export const CREDENTIAL_KINDS = [
  'API_KEY',
  'BASIC',
  'BEARER',
  'HMAC_SECRET',
  'WEBHOOK_SECRET',
  'OAUTH_TOKENS',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Entities a connector can pull / push. Importers exist per entity. */
export const SYNC_ENTITIES = [
  'customers',
  'vendors',
  'invoices',
  'bills',
  'payments',
  'bank-transactions',
  'products',
  'sales-orders',
  'purchase-orders',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

// --------------------------------------------------------------------- sync

export const SYNC_MODES = ['INCREMENTAL', 'FULL'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export const SYNC_TRIGGERS = ['MANUAL', 'SCHEDULED', 'RETRY', 'RESUME', 'WEBHOOK'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'PAUSED',
] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number];

// --------------------------------------------------------------- logs/errors

export const INTEGRATION_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export type IntegrationDirection = (typeof INTEGRATION_DIRECTIONS)[number];

export const INTEGRATION_LOG_STATUSES = ['SUCCESS', 'FAILURE', 'SKIPPED'] as const;
export type IntegrationLogStatus = (typeof INTEGRATION_LOG_STATUSES)[number];

export const INTEGRATION_ERROR_CODES = [
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'PROVIDER_ERROR',
  'MAPPING_ERROR',
  'DUPLICATE',
  'IDEMPOTENCY_CONFLICT',
  'UNKNOWN_ERROR',
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

// ------------------------------------------------------------------ webhooks

export const WEBHOOK_SUBSCRIPTION_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type WebhookSubscriptionStatus = (typeof WEBHOOK_SUBSCRIPTION_STATUSES)[number];

export const WEBHOOK_DELIVERY_STATUSES = [
  'PENDING',
  'DELIVERED',
  'FAILED',
  'RETRYING',
  'EXHAUSTED',
  'DISABLED',
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Outbox rows (OUTBOUND) and received webhooks (INBOUND) share one table. */
export const INTEGRATION_EVENT_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'DUPLICATE',
  'REJECTED',
] as const;
export type IntegrationEventStatus = (typeof INTEGRATION_EVENT_STATUSES)[number];

/** Events the platform publishes to outbound webhooks. */
export const OUTBOUND_EVENT_TYPES = [
  'customer.created',
  'customer.updated',
  'vendor.created',
  'vendor.updated',
  'invoice.created',
  'invoice.approved',
  'invoice.posted',
  'invoice.paid',
  'invoice.overdue',
  'invoice.voided',
  'invoice.cancelled',
  'invoice.disputed',
  'credit_note.posted',
  'debit_note.posted',
  'sales_order.created',
  'sales_order.submitted',
  'sales_order.approved',
  'sales_order.confirmed',
  'sales_order.cancelled',
  'delivery.created',
  'delivery.delivered',
  'customer.credit_hold',
  'customer.credit_released',
  'customer.over_credit_limit',
  'collection.case_opened',
  'collection.promise_broken',
  'write_off.posted',
  'refund.approved',
  'purchase_order.submitted',
  'purchase_order.approved',
  'purchase_order.rejected',
  'goods_receipt.confirmed',
  'bill.submitted',
  'bill.on_hold',
  'bill.released',
  'bill.due_soon',
  'bill.voided',
  'vendor_credit.posted',
  'vendor_payment.approved',
  'vendor_payment.posted',
  'vendor_payment.voided',
  'payment_run.submitted',
  'payment_run.approved',
  'payment_run.executed',
  'vendor.on_hold',
  'vendor.released',
  'vendor.approved',
  'ap_accrual.posted',
  'bill.created',
  'bill.approved',
  'bill.posted',
  'payment.created',
  'payment.approved',
  'payment.received',
  'payment.completed',
  'payment.allocated',
  'payment.refunded',
  'payment.failed',
  'journal.posted',
  'journal.reversed',
  'purchase.created',
  'purchase.approved',
  'inventory.received',
  'inventory.issued',
  'bank.transaction.imported',
  'bank.transaction.matched',
  'period.closed',
  'webhook.test',
] as const;
export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];

/** Events an external system may send us (connectors normalise provider names to these). */
export const INBOUND_EVENT_TYPES = [
  'payment.received',
  'order.created',
  'invoice.paid',
  'bank.transaction.created',
  'customer.updated',
] as const;
export type InboundEventType = (typeof INBOUND_EVENT_TYPES)[number];

// --------------------------------------------------------------------- OAuth

export const OAUTH_CONNECTION_STATUSES = [
  'PENDING',
  'CONNECTED',
  'EXPIRED',
  'REVOKED',
  'FAILED',
] as const;
export type OAuthConnectionStatus = (typeof OAUTH_CONNECTION_STATUSES)[number];

// ------------------------------------------------------------------ API keys

export const API_KEY_STATUSES = ['ACTIVE', 'REVOKED', 'EXPIRED'] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/** Prefix of every secret we mint; lets the auth guard route Bearer tokens. */
export const API_KEY_PREFIX = 'ak_';

/**
 * Granular API scopes. A scope grants a *subset* of the owner's permissions:
 * a key can never do more than the person who created it, and no scope maps
 * to posting authority unless it is an explicit `:post` scope.
 */
export const API_SCOPE_DEFINITIONS = [
  ['companies:read', 'Read companies and branches', ['company.view', 'branch.view']],
  ['customers:read', 'Read customers', ['customer.view']],
  ['customers:write', 'Create and update customers', ['customer.view', 'customer.manage']],
  ['vendors:read', 'Read vendors', ['vendor.view']],
  ['vendors:write', 'Create and update vendors', ['vendor.view', 'vendor.manage']],
  ['invoices:read', 'Read invoices and credit notes', ['invoice.view', 'customer.view']],
  ['invoices:write', 'Create draft invoices', ['invoice.view', 'customer.view', 'invoice.create']],
  [
    'invoices:post',
    'Approve and post invoices (explicit - never granted by default)',
    ['invoice.view', 'invoice.approve', 'invoice.post'],
  ],
  ['bills:read', 'Read vendor bills', ['bill.view', 'vendor.view']],
  ['bills:write', 'Create draft vendor bills', ['bill.view', 'vendor.view', 'bill.create']],
  [
    'bills:post',
    'Approve and post vendor bills (explicit - never granted by default)',
    ['bill.view', 'bill.approve', 'bill.post'],
  ],
  ['payments:read', 'Read customer and vendor payments', ['invoice.view', 'bill.view']],
  [
    'payments:write',
    'Record draft customer payments',
    ['invoice.view', 'customer.view', 'customer-payment.create'],
  ],
  [
    'payments:post',
    'Post customer payments (explicit - never granted by default)',
    ['invoice.view', 'customer-payment.post'],
  ],
  [
    'sales-orders:read',
    'Read quotations and sales orders',
    ['sales-order.view', 'quotation.view', 'customer.view'],
  ],
  [
    'sales-orders:write',
    'Create draft sales orders (never approves them)',
    ['sales-order.view', 'customer.view', 'sales-order.create'],
  ],
  ['deliveries:read', 'Read deliveries', ['delivery.view', 'sales-order.view']],
  [
    'purchase-orders:read',
    'Read purchase requests and purchase orders',
    ['purchase-order.view', 'purchase-request.view', 'vendor.view'],
  ],
  [
    'purchase-orders:write',
    'Create draft purchase orders (never approves them)',
    ['purchase-order.view', 'vendor.view', 'purchase-order.create'],
  ],
  [
    'payment-runs:read',
    'Read payment runs, remittances and cash requirements',
    ['payment-run.view', 'vendor.view', 'bill.view', 'reports.view'],
  ],
  [
    'collections:read',
    'Read collection cases, promises, disputes and aging',
    ['collection.view', 'customer.view', 'invoice.view', 'reports.view'],
  ],
  ['products:read', 'Read products', ['product.view']],
  ['products:write', 'Create and update products', ['product.view', 'product.manage']],
  ['inventory:read', 'Read stock levels and movements', ['inventory.view', 'product.view']],
  ['inventory:write', 'Record stock adjustments', ['inventory.view', 'inventory.adjust']],
  ['journals:read', 'Read journal entries and the ledger', ['journal.view', 'account.view']],
  [
    'journals:create',
    'Create DRAFT journal entries (never posts)',
    ['journal.view', 'account.view', 'journal.create'],
  ],
  ['reports:read', 'Read financial reports', ['reports.view', 'account.view']],
  ['banking:read', 'Read bank accounts and statements', ['bank-account.view']],
  [
    'banking:write',
    'Import bank statements and record bank transactions',
    ['bank-account.view', 'bank-statement.import', 'bank-transaction.create'],
  ],
  ['webhooks:manage', 'Manage outbound webhook subscriptions', ['webhook.manage']],
  ['integrations:manage', 'Manage integrations', ['integration.view', 'integration.manage']],
] as const satisfies ReadonlyArray<readonly [string, string, readonly PermissionKey[]]>;

export type ApiScope = (typeof API_SCOPE_DEFINITIONS)[number][0];
export const API_SCOPES = API_SCOPE_DEFINITIONS.map((s) => s[0]) as readonly ApiScope[];

/** Permissions a scope grants (before intersecting with the owner's own permissions). */
export const SCOPE_PERMISSIONS: Readonly<Record<ApiScope, readonly PermissionKey[]>> =
  Object.fromEntries(
    API_SCOPE_DEFINITIONS.map(([scope, , perms]) => [scope, perms]),
  ) as unknown as Record<ApiScope, readonly PermissionKey[]>;

export const SCOPE_DESCRIPTIONS: Readonly<Record<ApiScope, string>> = Object.fromEntries(
  API_SCOPE_DEFINITIONS.map(([scope, description]) => [scope, description]),
) as Record<ApiScope, string>;

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Expands scopes to the permission set they carry. */
export function permissionsForScopes(scopes: readonly string[]): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const scope of scopes) {
    if (!isApiScope(scope)) continue;
    for (const p of SCOPE_PERMISSIONS[scope]) out.add(p);
  }
  return out;
}

// ------------------------------------------------------------- notifications

export const NOTIFICATION_SEVERITIES = ['INFO', 'WARNING', 'ERROR'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_EVENT_TYPES = [
  'INTEGRATION_FAILED',
  'CREDENTIALS_EXPIRING',
  'WEBHOOK_FAILING',
  'SYNC_FAILED',
  'DELEGATION_CREATED',
  'DELEGATION_APPROVAL_REQUIRED',
  'DELEGATION_APPROVED',
  'DELEGATION_REJECTED',
  'DELEGATION_EXPIRING',
  'DELEGATION_REVOKED',
  'APPROVAL_REQUIRED',
  'INVOICE_APPROVED',
  'INVOICE_POSTED',
  'INVOICE_OVERDUE',
  'PAYMENT_RECEIVED',
  'PAYMENT_FAILED',
  'CUSTOMER_OVER_CREDIT_LIMIT',
  'CUSTOMER_CREDIT_HOLD',
  'COLLECTION_ACTION_REQUIRED',
  'PROMISE_BROKEN',
  'DISPUTE_OPENED',
  'WRITE_OFF_APPROVAL_REQUIRED',
  'REFUND_APPROVAL_REQUIRED',
  'AR_RECONCILIATION_DIFFERENCE',
  'BILL_APPROVAL_REQUIRED',
  'BILL_APPROVED',
  'BILL_POSTED',
  'BILL_DUE_SOON',
  'BILL_ON_HOLD',
  'DISCOUNT_EXPIRING',
  'VENDOR_APPROVAL_REQUIRED',
  'VENDOR_ON_HOLD',
  'PAYMENT_RUN_APPROVAL_REQUIRED',
  'PAYMENT_RUN_EXECUTED',
  'VENDOR_PAYMENT_APPROVAL_REQUIRED',
  'GRNI_AGED',
  'AP_RECONCILIATION_DIFFERENCE',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
