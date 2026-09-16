import { z } from 'zod';
import {
  COLLECTION_ACTIVITY_TYPES,
  COLLECTION_CASE_STATUSES,
  CREDIT_RISK_RATINGS,
  CREDIT_RULE_ACTIONS,
  CREDIT_RULE_SCOPES,
  CREDIT_RULE_TRIGGERS,
  CUSTOMER_ADDRESS_TYPES,
  DELIVERY_STATUSES,
  DISPUTE_REASONS,
  DISPUTE_RESOLUTIONS,
  DISPUTE_STATUSES,
  DUNNING_ACTIONS,
  ENTITY_STATUSES,
  PAYMENT_TERM_BASES,
  PROMISE_STATUSES,
  PROVISION_METHODS,
  REFUND_REQUEST_STATUSES,
  WRITE_OFF_REASONS,
  WRITE_OFF_STATUSES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import {
  addressSchema,
  codeSchema,
  emailSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  queryBooleanSchema,
  uuidSchema,
} from './primitives';
import { percentSchema, quantitySchema } from './subledger';

// -------------------------------------------------------------- payment terms

export const createPaymentTermSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    basis: z.enum(PAYMENT_TERM_BASES).default('NET_DAYS'),
    /** NET_DAYS / END_OF_MONTH: days added; DAY_OF_NEXT_MONTH: ignored. */
    days: z.coerce.number().int().min(0).max(365).default(30),
    /** DAY_OF_NEXT_MONTH only. */
    dayOfMonth: z.coerce.number().int().min(1).max(28).nullable().optional(),
    /** Early-payment discount (informational for now; settlement discounts are a later feature). */
    discountPercent: percentSchema.default('0'),
    discountDays: z.coerce.number().int().min(0).max(365).default(0),
    description: optionalText(300),
  })
  .refine((v) => v.basis !== 'DAY_OF_NEXT_MONTH' || v.dayOfMonth, {
    message: 'Day of month is required for this basis',
    path: ['dayOfMonth'],
  });
export type CreatePaymentTermInput = z.infer<typeof createPaymentTermSchema>;
export const updatePaymentTermSchema = z.object({
  name: nameSchema.optional(),
  basis: z.enum(PAYMENT_TERM_BASES).optional(),
  days: z.coerce.number().int().min(0).max(365).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).nullable().optional(),
  discountPercent: percentSchema.optional(),
  discountDays: z.coerce.number().int().min(0).max(365).optional(),
  description: optionalText(300),
  status: z.enum(ENTITY_STATUSES).optional(),
});
export type UpdatePaymentTermInput = z.infer<typeof updatePaymentTermSchema>;

// ------------------------------------------------------------ customer groups

export const createCustomerGroupSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: optionalText(300),
  /** Defaults applied to new customers in the group (each customer may override). */
  paymentTermId: uuidSchema.nullable().optional(),
  defaultCreditLimit: amountSchema.nullable().optional(),
  taxCodeId: uuidSchema.nullable().optional(),
  /** Percentage discount applied to list prices for the group (pricing policy). */
  priceDiscountPercent: percentSchema.default('0'),
  dunningPolicyId: uuidSchema.nullable().optional(),
});
export type CreateCustomerGroupInput = z.infer<typeof createCustomerGroupSchema>;
export const updateCustomerGroupSchema = createCustomerGroupSchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateCustomerGroupInput = z.infer<typeof updateCustomerGroupSchema>;

// ---------------------------------------------------------- customer contacts

export const customerContactSchema = z.object({
  name: nameSchema,
  title: optionalText(80),
  role: optionalText(80),
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  phone: optionalText(40),
  isPrimary: z.boolean().default(false),
  notes: optionalText(500),
});
export type CustomerContactInput = z.infer<typeof customerContactSchema>;

export const customerAddressSchema = addressSchema.extend({
  addressType: z.enum(CUSTOMER_ADDRESS_TYPES),
  label: optionalText(80),
  attention: optionalText(120),
  isDefault: z.boolean().default(false),
});
export type CustomerAddressInput = z.infer<typeof customerAddressSchema>;

// ------------------------------------------------------------ credit profile

export const creditProfileSchema = z.object({
  creditLimit: amountSchema.nullable().optional(),
  creditHold: z.boolean().optional(),
  creditHoldReason: optionalText(500),
  riskRating: z.enum(CREDIT_RISK_RATINGS).optional(),
  /** Next credit review date. */
  reviewDate: isoDateSchema.nullable().optional(),
  notes: optionalText(1000),
});
export type CreditProfileInput = z.infer<typeof creditProfileSchema>;

export const createCreditRuleSchema = z.object({
  name: nameSchema,
  description: optionalText(300),
  scope: z.enum(CREDIT_RULE_SCOPES),
  trigger: z.enum(CREDIT_RULE_TRIGGERS),
  action: z.enum(CREDIT_RULE_ACTIONS),
  /** OVERDUE_BALANCE: amount; EXPOSURE_OVER_LIMIT: percent over the limit (0 = at the limit); DAYS_OVERDUE: days. */
  thresholdAmount: amountSchema.nullable().optional(),
  thresholdPercent: percentSchema.nullable().optional(),
  thresholdDays: z.coerce.number().int().min(0).max(3650).nullable().optional(),
  /** Restrict to one customer group (null = every customer). */
  customerGroupId: uuidSchema.nullable().optional(),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
});
export type CreateCreditRuleInput = z.infer<typeof createCreditRuleSchema>;
export const updateCreditRuleSchema = createCreditRuleSchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateCreditRuleInput = z.infer<typeof updateCreditRuleSchema>;

// ----------------------------------------------------------------- deliveries

export const deliveryLineSchema = z.object({
  orderLineId: uuidSchema,
  quantity: quantitySchema,
  warehouseId: uuidSchema.nullable().optional(),
  lotNumber: optionalText(60),
  serialNumbers: z.array(z.string().trim().min(1).max(80)).max(1000).optional(),
});
export type DeliveryLineInput = z.infer<typeof deliveryLineSchema>;

export const createDeliverySchema = z.object({
  salesOrderId: uuidSchema,
  deliveryDate: isoDateSchema,
  warehouseId: uuidSchema.nullable().optional(),
  branchId: uuidSchema.nullable().optional(),
  reference: optionalText(100),
  notes: optionalText(2000),
  shippingAddressId: uuidSchema.nullable().optional(),
  /** Omit to deliver every outstanding quantity on the order. */
  lines: z.array(deliveryLineSchema).max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;
export const updateDeliverySchema = createDeliverySchema
  .omit({ idempotencyKey: true, salesOrderId: true })
  .partial();
export type UpdateDeliveryInput = z.infer<typeof updateDeliverySchema>;

export const listDeliveriesQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  salesOrderId: uuidSchema.optional(),
  status: z.enum(DELIVERY_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;

export const deliveryActionSchema = z.object({
  reason: optionalText(500),
  /** DELIVER only: overrides the planned delivery date. */
  deliveryDate: isoDateSchema.optional(),
});
export type DeliveryActionInput = z.infer<typeof deliveryActionSchema>;

// -------------------------------------------------------------------- refunds

export const createRefundRequestSchema = z.object({
  customerId: uuidSchema,
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
  /** The overpaid / unapplied receipt being refunded (optional, informational). */
  paymentId: uuidSchema.nullable().optional(),
  /** Credit note whose balance is refunded (optional, informational). */
  creditNoteId: uuidSchema.nullable().optional(),
  method: z
    .enum([
      'CASH',
      'BANK_TRANSFER',
      'CHECK',
      'CARD',
      'DEBIT_CARD',
      'ONLINE',
      'PAYMENT_GATEWAY',
      'OTHER',
    ])
    .default('BANK_TRANSFER'),
  cashAccountId: uuidSchema,
  reference: optionalText(100),
  branchId: uuidSchema.nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateRefundRequestInput = z.infer<typeof createRefundRequestSchema>;

export const refundDecisionSchema = z.object({
  comment: optionalText(500),
});
export type RefundDecisionInput = z.infer<typeof refundDecisionSchema>;

export const payRefundSchema = z.object({
  paymentDate: isoDateSchema,
  reference: optionalText(100),
});
export type PayRefundInput = z.infer<typeof payRefundSchema>;

export const listRefundsQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  status: z.enum(REFUND_REQUEST_STATUSES).optional(),
});
export type ListRefundsQuery = z.infer<typeof listRefundsQuerySchema>;

// ---------------------------------------------------------------- collections

export const createCollectionCaseSchema = z.object({
  customerId: uuidSchema,
  collectorId: uuidSchema.nullable().optional(),
  nextActionAt: isoDateSchema.nullable().optional(),
  nextAction: optionalText(300),
  notes: optionalText(2000),
});
export type CreateCollectionCaseInput = z.infer<typeof createCollectionCaseSchema>;

export const updateCollectionCaseSchema = z.object({
  collectorId: uuidSchema.nullable().optional(),
  status: z.enum(COLLECTION_CASE_STATUSES).optional(),
  nextActionAt: isoDateSchema.nullable().optional(),
  nextAction: optionalText(300),
  notes: optionalText(2000),
});
export type UpdateCollectionCaseInput = z.infer<typeof updateCollectionCaseSchema>;

export const listCollectionCasesQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  collectorId: uuidSchema.optional(),
  status: z.enum(COLLECTION_CASE_STATUSES).optional(),
  openOnly: queryBooleanSchema.optional(),
});
export type ListCollectionCasesQuery = z.infer<typeof listCollectionCasesQuerySchema>;

export const collectionActivitySchema = z.object({
  activityType: z.enum(COLLECTION_ACTIVITY_TYPES),
  summary: z.string().trim().min(1, 'A summary is required').max(300),
  details: optionalText(2000),
  contactName: optionalText(120),
  /** Schedules the next action on the case. */
  nextActionAt: isoDateSchema.nullable().optional(),
  nextAction: optionalText(300),
  invoiceId: uuidSchema.nullable().optional(),
});
export type CollectionActivityInput = z.infer<typeof collectionActivitySchema>;

export const createPromiseSchema = z.object({
  customerId: uuidSchema,
  caseId: uuidSchema.nullable().optional(),
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  promiseDate: isoDateSchema,
  invoiceIds: z.array(uuidSchema).max(200).default([]),
  notes: optionalText(1000),
});
export type CreatePromiseInput = z.infer<typeof createPromiseSchema>;

export const updatePromiseSchema = z.object({
  status: z.enum(PROMISE_STATUSES).optional(),
  notes: optionalText(1000),
});
export type UpdatePromiseInput = z.infer<typeof updatePromiseSchema>;

export const listPromisesQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  caseId: uuidSchema.optional(),
  status: z.enum(PROMISE_STATUSES).optional(),
});
export type ListPromisesQuery = z.infer<typeof listPromisesQuerySchema>;

export const creditHoldSchema = z.object({
  hold: z.boolean(),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type CreditHoldInput = z.infer<typeof creditHoldSchema>;

// -------------------------------------------------------------------- dunning

export const dunningStepSchema = z.object({
  daysOverdue: z.coerce.number().int().min(0).max(3650),
  action: z.enum(DUNNING_ACTIONS),
  label: z.string().trim().min(1).max(80),
});

export const createDunningPolicySchema = z.object({
  name: nameSchema,
  description: optionalText(300),
  steps: z
    .array(dunningStepSchema)
    .min(1, 'At least one step is required')
    .max(20)
    .refine(
      (steps) => steps.every((s, i) => i === 0 || s.daysOverdue > steps[i - 1]!.daysOverdue),
      'Steps must be in ascending days-overdue order',
    ),
  /** Minimum overdue amount before the policy acts (skips trivial balances). */
  minimumAmount: amountSchema.default('0'),
  isDefault: z.boolean().default(false),
});
export type CreateDunningPolicyInput = z.infer<typeof createDunningPolicySchema>;
export const updateDunningPolicySchema = createDunningPolicySchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateDunningPolicyInput = z.infer<typeof updateDunningPolicySchema>;

// ------------------------------------------------------------------- disputes

export const createDisputeSchema = z.object({
  invoiceId: uuidSchema,
  reason: z.enum(DISPUTE_REASONS),
  /** Amount in dispute (defaults to the invoice balance). */
  amount: amountSchema.optional(),
  description: z.string().trim().min(1, 'Describe the dispute').max(2000),
  raisedBy: optionalText(120),
  assigneeId: uuidSchema.nullable().optional(),
});
export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;

export const updateDisputeSchema = z.object({
  status: z.enum(DISPUTE_STATUSES).optional(),
  assigneeId: uuidSchema.nullable().optional(),
  resolution: z.enum(DISPUTE_RESOLUTIONS).nullable().optional(),
  resolutionNotes: optionalText(2000),
  /** Credit note issued to settle the dispute (must be posted for the same customer). */
  creditNoteId: uuidSchema.nullable().optional(),
  amount: amountSchema.optional(),
});
export type UpdateDisputeInput = z.infer<typeof updateDisputeSchema>;

export const listDisputesQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  invoiceId: uuidSchema.optional(),
  status: z.enum(DISPUTE_STATUSES).optional(),
  openOnly: queryBooleanSchema.optional(),
});
export type ListDisputesQuery = z.infer<typeof listDisputesQuerySchema>;

// ----------------------------------------------------------------- write-offs

export const createWriteOffSchema = z.object({
  invoiceId: uuidSchema,
  /** Defaults to the invoice's open balance. */
  amount: amountSchema.optional(),
  reason: z.enum(WRITE_OFF_REASONS),
  justification: z.string().trim().min(1, 'A justification is required').max(2000),
  /** Posting date of the write-off journal (defaults to the approval date). */
  writeOffDate: isoDateSchema.optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateWriteOffInput = z.infer<typeof createWriteOffSchema>;

export const writeOffDecisionSchema = z.object({
  comment: optionalText(500),
});
export type WriteOffDecisionInput = z.infer<typeof writeOffDecisionSchema>;

export const listWriteOffsQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
  status: z.enum(WRITE_OFF_STATUSES).optional(),
});
export type ListWriteOffsQuery = z.infer<typeof listWriteOffsQuerySchema>;

export const recoverWriteOffSchema = z.object({
  recoveryDate: isoDateSchema,
  reason: z.string().trim().min(1).max(500),
});
export type RecoverWriteOffInput = z.infer<typeof recoverWriteOffSchema>;

// ------------------------------------------------------------ bad debt runs

export const createProvisionRunSchema = z.object({
  asOf: isoDateSchema,
  method: z.enum(PROVISION_METHODS).default('AGING_PERCENT'),
  /** Overrides the rates in AR settings for this run (bucket key -> percent). */
  rates: z.record(z.string(), percentSchema).optional(),
  /** SPECIFIC: explicit allowance per invoice. */
  specific: z
    .array(z.object({ invoiceId: uuidSchema, amount: amountSchema }))
    .max(500)
    .optional(),
  description: optionalText(300),
});
export type CreateProvisionRunInput = z.infer<typeof createProvisionRunSchema>;

// ---------------------------------------------------------------- settings

export const agingBucketSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z][a-z0-9]*$/, 'Bucket keys are lowercase alphanumerics'),
  label: z.string().trim().min(1).max(40),
  from: z.coerce.number().int(),
  to: z.coerce.number().int().nullable(),
});

export const arSettingsSchema = z.object({
  agingBuckets: z
    .array(agingBucketSchema)
    .min(2)
    .max(12)
    .refine((b) => b[0]!.to !== null && b[b.length - 1]!.to === null, {
      message: 'The last bucket must be open-ended (to = null) and the first bounded',
    })
    .refine(
      (b) => b.every((x, i) => i === 0 || x.from === (b[i - 1]!.to ?? Infinity) + 1),
      'Buckets must be contiguous',
    )
    .optional(),
  /** Days of revenue used for DSO (countback window). */
  dsoWindowDays: z.coerce.number().int().min(30).max(365).optional(),
  /** Unapplied cash older than this many days is flagged on the dashboard. */
  unappliedCashWarnDays: z.coerce.number().int().min(1).max(365).optional(),
  /** Small balances up to this amount may be written off with reason SMALL_BALANCE. */
  smallBalanceThreshold: amountSchema.optional(),
  /** Open a collection case automatically once an invoice is this many days overdue (0 = never). */
  autoCaseDaysOverdue: z.coerce.number().int().min(0).max(365).optional(),
  /** Customer payments must be approved before posting. */
  requirePaymentApproval: z.boolean().optional(),
  /** Post write-offs with reason BAD_DEBT against the allowance (true) or straight to expense (false). */
  useAllowanceForBadDebt: z.boolean().optional(),
  /** Allowance rates per aging bucket for AGING_PERCENT provisioning. */
  provisionRates: z.record(z.string(), percentSchema).optional(),
  /** Trigger the credit rules when a sales order is submitted / approved. */
  creditCheckOnSalesOrder: z.boolean().optional(),
  /** Trigger the credit rules when an invoice is submitted / approved. */
  creditCheckOnInvoice: z.boolean().optional(),
  defaultDunningPolicyId: uuidSchema.nullable().optional(),
  defaultPaymentTermId: uuidSchema.nullable().optional(),
});
export type ArSettingsInput = z.infer<typeof arSettingsSchema>;

// ----------------------------------------------------------------- reports

export const arDashboardQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
});
export type ArDashboardQuery = z.infer<typeof arDashboardQuerySchema>;

export const customerStatementsQuerySchema = z.object({
  customerId: uuidSchema,
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: uuidSchema.optional(),
  /** Persist the generated statement as a snapshot. */
  save: queryBooleanSchema.optional(),
});
export type CustomerStatementsQuery = z.infer<typeof customerStatementsQuerySchema>;

export const listCustomerStatementsQuerySchema = paginationQuerySchema.extend({
  customerId: uuidSchema.optional(),
});
export type ListCustomerStatementsQuery = z.infer<typeof listCustomerStatementsQuerySchema>;
