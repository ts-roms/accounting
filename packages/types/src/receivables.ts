/**
 * Accounts receivable, order-to-cash and collections (Prompt #6). These
 * enumerations are mirrored as PostgreSQL enums; the shared AR/AP ones
 * (document statuses, payment statuses) live in `subledger.ts`.
 */

// ------------------------------------------------------------------ customers

export const CUSTOMER_TYPES = ['INDIVIDUAL', 'BUSINESS', 'GOVERNMENT', 'OTHER'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const CUSTOMER_ADDRESS_TYPES = ['BILLING', 'SHIPPING'] as const;
export type CustomerAddressType = (typeof CUSTOMER_ADDRESS_TYPES)[number];

/** How a payment term turns a document date into a due date. */
export const PAYMENT_TERM_BASES = [
  /** Due on the document date (cash on delivery, due on receipt). */
  'DUE_ON_RECEIPT',
  /** Document date + `days`. */
  'NET_DAYS',
  /** End of the document month + `days`. */
  'END_OF_MONTH',
  /** `dayOfMonth` of the following month (e.g. the 15th). */
  'DAY_OF_NEXT_MONTH',
] as const;
export type PaymentTermBasis = (typeof PAYMENT_TERM_BASES)[number];

// --------------------------------------------------------------------- credit

export const CREDIT_STATUSES = ['GOOD', 'WARNING', 'ON_HOLD', 'OVER_LIMIT'] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

export const CREDIT_RISK_RATINGS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type CreditRiskRating = (typeof CREDIT_RISK_RATINGS)[number];

/** What a credit rule looks at. */
export const CREDIT_RULE_TRIGGERS = [
  /** Exposure (open balance + unposted documents + this document) exceeds the credit limit by `thresholdPercent`. */
  'EXPOSURE_OVER_LIMIT',
  /** Overdue balance exceeds `thresholdAmount`. */
  'OVERDUE_BALANCE',
  /** Oldest overdue document is older than `thresholdDays`. */
  'DAYS_OVERDUE',
  /** The customer is on credit hold. */
  'CREDIT_HOLD',
  /** The customer has no credit limit at all. */
  'NO_CREDIT_LIMIT',
] as const;
export type CreditRuleTrigger = (typeof CREDIT_RULE_TRIGGERS)[number];

/** What happens when a rule fires. */
export const CREDIT_RULE_ACTIONS = ['WARN', 'REQUIRE_APPROVAL', 'BLOCK'] as const;
export type CreditRuleAction = (typeof CREDIT_RULE_ACTIONS)[number];

/** Documents a credit rule can gate. */
export const CREDIT_RULE_SCOPES = ['SALES_ORDER', 'INVOICE'] as const;
export type CreditRuleScope = (typeof CREDIT_RULE_SCOPES)[number];

// ----------------------------------------------------------------- deliveries

export const DELIVERY_STATUSES = ['DRAFT', 'PICKING', 'READY', 'DELIVERED', 'CANCELLED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// ---------------------------------------------------------------- collections

export const COLLECTION_CASE_STATUSES = [
  'NEW',
  'CONTACTED',
  'PROMISED',
  'ESCALATED',
  'DISPUTED',
  'COLLECTED',
  'CLOSED',
] as const;
export type CollectionCaseStatus = (typeof COLLECTION_CASE_STATUSES)[number];

export const COLLECTION_ACTIVITY_TYPES = [
  'CALL',
  'EMAIL',
  'MEETING',
  'LETTER',
  'NOTE',
  'PROMISE',
  'ESCALATION',
  'DUNNING',
  'CREDIT_HOLD',
  'DISPUTE',
  'STATUS_CHANGE',
] as const;
export type CollectionActivityType = (typeof COLLECTION_ACTIVITY_TYPES)[number];

export const PROMISE_STATUSES = ['PENDING', 'KEPT', 'BROKEN', 'CANCELLED'] as const;
export type PromiseStatus = (typeof PROMISE_STATUSES)[number];

/** Steps of a dunning policy. */
export const DUNNING_ACTIONS = ['REMINDER', 'ESCALATION', 'CREDIT_HOLD'] as const;
export type DunningAction = (typeof DUNNING_ACTIONS)[number];

export interface DunningStep {
  /** Days after the due date at which the step fires (0 = on the due date). */
  daysOverdue: number;
  action: DunningAction;
  /** Short label used in the activity and notification, e.g. "First reminder". */
  label: string;
}

// ------------------------------------------------------------------- disputes

export const DISPUTE_REASONS = [
  'INCORRECT_QUANTITY',
  'INCORRECT_PRICE',
  'DUPLICATE_INVOICE',
  'TAX_ISSUE',
  'MISSING_DELIVERY',
  'CUSTOMER_REJECTION',
  'OTHER',
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const DISPUTE_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_RESOLUTIONS = [
  'UPHELD',
  'CREDIT_NOTE',
  'PARTIAL_CREDIT',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];

// ----------------------------------------------------------------- write-offs

export const WRITE_OFF_REASONS = ['BAD_DEBT', 'SMALL_BALANCE', 'UNCOLLECTIBLE', 'OTHER'] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

export const WRITE_OFF_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'POSTED',
  'RECOVERED',
  'REJECTED',
  'CANCELLED',
] as const;
export type WriteOffStatus = (typeof WRITE_OFF_STATUSES)[number];

/** How a bad-debt allowance run sizes the provision. */
export const PROVISION_METHODS = ['AGING_PERCENT', 'SPECIFIC'] as const;
export type ProvisionMethod = (typeof PROVISION_METHODS)[number];

export const PROVISION_STATUSES = ['DRAFT', 'POSTED', 'REVERSED'] as const;
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number];

// -------------------------------------------------------------------- refunds

export const REFUND_REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PAID',
  'REJECTED',
  'CANCELLED',
] as const;
export type RefundRequestStatus = (typeof REFUND_REQUEST_STATUSES)[number];

// -------------------------------------------------------------------- aging

/** Configurable aging bucket: `from`..`to` days past due (inclusive); `to` null = open-ended. */
export interface AgingBucketDefinition {
  key: string;
  label: string;
  from: number;
  to: number | null;
}

/** Default buckets (spec section 29); companies override them in `ar_settings`. */
export const DEFAULT_AGING_BUCKETS: readonly AgingBucketDefinition[] = [
  { key: 'current', label: 'Current', from: -1_000_000, to: 0 },
  { key: 'days1to30', label: '1-30', from: 1, to: 30 },
  { key: 'days31to60', label: '31-60', from: 31, to: 60 },
  { key: 'days61to90', label: '61-90', from: 61, to: 90 },
  { key: 'days91to120', label: '91-120', from: 91, to: 120 },
  { key: 'over120', label: '120+', from: 121, to: null },
];

/** Allowance rate per aging bucket for `AGING_PERCENT` provisioning; keys match the buckets. */
export type ProvisionRates = Record<string, string>;
