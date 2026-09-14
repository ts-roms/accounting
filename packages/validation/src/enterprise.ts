import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  ATTACHMENT_ENTITY_TYPES,
  ENTITY_STATUSES,
  EXCHANGE_RATE_SOURCES,
  INTERCOMPANY_STATUSES,
  WORKFLOW_DOCUMENT_TYPES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import {
  currencyCodeSchema,
  optionalCurrencyCodeSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  uuidSchema,
} from './primitives';

// ------------------------------------------------------------- multi-currency

/** Rates carry eight decimals; 1 unit of `fromCurrency` = `rate` units of `toCurrency`. */
export const exchangeRateValueSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,8})?$/, 'Rate must be a positive decimal with up to 8 places')
  .refine((v) => Number(v) > 0, 'Rate must be positive');

export const upsertExchangeRateSchema = z
  .object({
    fromCurrency: currencyCodeSchema,
    toCurrency: currencyCodeSchema,
    rateDate: isoDateSchema,
    rate: exchangeRateValueSchema,
    source: z.enum(EXCHANGE_RATE_SOURCES).default('MANUAL'),
    notes: optionalText(300),
  })
  .refine((r) => r.fromCurrency !== r.toCurrency, {
    message: 'From and to currencies must differ',
    path: ['toCurrency'],
  });
export type UpsertExchangeRateInput = z.infer<typeof upsertExchangeRateSchema>;

export const listExchangeRatesQuerySchema = z.object({
  fromCurrency: optionalCurrencyCodeSchema,
  toCurrency: optionalCurrencyCodeSchema,
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListExchangeRatesQuery = z.infer<typeof listExchangeRatesQuerySchema>;

export const resolveRateQuerySchema = z.object({
  fromCurrency: currencyCodeSchema,
  toCurrency: currencyCodeSchema,
  onDate: isoDateSchema,
});
export type ResolveRateQuery = z.infer<typeof resolveRateQuerySchema>;

/** Period-end revaluation of open foreign-currency receivables and payables. */
export const createFxRevaluationSchema = z.object({
  asOfDate: isoDateSchema,
  /** Date of the automatic reversing entry; defaults to the day after `asOfDate`. */
  reversalDate: isoDateSchema.optional(),
  notes: optionalText(500),
});
export type CreateFxRevaluationInput = z.infer<typeof createFxRevaluationSchema>;

// ---------------------------------------------------------------- intercompany

export const createIntercompanySchema = z
  .object({
    fromCompanyId: uuidSchema,
    toCompanyId: uuidSchema,
    transactionDate: isoDateSchema,
    description: z.string().trim().min(1, 'Description is required').max(500),
    reference: optionalText(100),
    amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
    /** Account debited in the originating company (expense, asset...). */
    fromAccountId: uuidSchema,
    /** Account credited in the receiving company (revenue, liability...). */
    toAccountId: uuidSchema,
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
  })
  .refine((t) => t.fromCompanyId !== t.toCompanyId, {
    message: 'The two companies must differ',
    path: ['toCompanyId'],
  });
export type CreateIntercompanyInput = z.infer<typeof createIntercompanySchema>;

export const listIntercompanyQuerySchema = paginationQuerySchema.extend({
  status: z.enum(INTERCOMPANY_STATUSES).optional(),
  companyId: uuidSchema.optional(),
});
export type ListIntercompanyQuery = z.infer<typeof listIntercompanyQuerySchema>;

export const consolidationQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  /** Defaults to every active company of the organization. */
  companyIds: z
    .union([
      z.array(uuidSchema),
      z
        .string()
        .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
        .pipe(z.array(uuidSchema)),
    ])
    .optional(),
  /** Presentation currency; defaults to the organization's reporting currency. */
  currency: optionalCurrencyCodeSchema,
});
export type ConsolidationQuery = z.infer<typeof consolidationQuerySchema>;

// ------------------------------------------------------------------ workflows

export const workflowStepSchema = z.object({
  name: nameSchema,
  /** Permission an approver must hold for this step. */
  requiredPermission: z.string().trim().min(3).max(100),
  /** Distinct approvers needed before the step completes. */
  minApprovers: z.coerce.number().int().min(1).max(10).default(1),
});
export type WorkflowStepInput = z.infer<typeof workflowStepSchema>;

export const createWorkflowSchema = z
  .object({
    documentType: z.enum(WORKFLOW_DOCUMENT_TYPES),
    name: nameSchema,
    description: optionalText(500),
    /** Applies when the document amount is at least this value (inclusive). */
    minAmount: amountSchema.default('0'),
    /** Upper bound (exclusive); null = no upper bound. */
    maxAmount: amountSchema.nullable().optional(),
    /** Lower priority number wins when several workflows match. */
    priority: z.coerce.number().int().min(0).max(1000).default(100),
    /** Whether the requester may also act as an approver on their own document. */
    allowSelfApproval: z.boolean().default(false),
    steps: z.array(workflowStepSchema).min(1, 'At least one step').max(10),
  })
  .refine((w) => w.maxAmount === null || w.maxAmount === undefined || Number(w.maxAmount) > Number(w.minAmount), {
    message: 'Max amount must exceed min amount',
    path: ['maxAmount'],
  });
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const updateWorkflowSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
  minAmount: amountSchema.optional(),
  maxAmount: amountSchema.nullable().optional(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  allowSelfApproval: z.boolean().optional(),
  steps: z.array(workflowStepSchema).min(1).max(10).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;

export const listApprovalsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(APPROVAL_REQUEST_STATUSES).optional(),
  documentType: z.enum(WORKFLOW_DOCUMENT_TYPES).optional(),
  /** Only requests the acting user can decide on right now. */
  mine: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .optional(),
});
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;

export const decideApprovalSchema = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  comment: optionalText(500),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

// ------------------------------------------------------------------ documents

export const attachmentEntitySchema = z.object({
  entityType: z.enum(ATTACHMENT_ENTITY_TYPES),
  entityId: uuidSchema,
});
export type AttachmentEntityInput = z.infer<typeof attachmentEntitySchema>;

export const attachmentMetaSchema = z.object({
  description: optionalText(300),
});
export type AttachmentMetaInput = z.infer<typeof attachmentMetaSchema>;
