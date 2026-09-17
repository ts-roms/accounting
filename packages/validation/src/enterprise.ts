import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  ATTACHMENT_ENTITY_TYPES,
  ENTITY_STATUSES,
  EXCHANGE_RATE_SOURCES,
  INTERCOMPANY_STATUSES,
  WORKFLOW_DOCUMENT_TYPES,
  RECONCILIATION_AREAS,
  SUBLEDGER_RECONCILIATION_STATUSES,
  CLOSE_STATUSES,
  CLOSE_TYPES,
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
        .transform((v) =>
          v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        )
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
    /** Restrict the workflow to documents of one branch; null = every branch. */
    branchId: z.string().uuid().nullable().optional(),
    /** Hours a request may stay pending before it is overdue and escalates. */
    deadlineHours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .nullable()
      .optional(),
    /** Permission whose holders may decide an overdue request in place of the step approvers. */
    escalationPermission: z.string().trim().min(3).max(100).nullable().optional(),
    steps: z.array(workflowStepSchema).min(1, 'At least one step').max(10),
  })
  .refine(
    (w) =>
      w.maxAmount === null ||
      w.maxAmount === undefined ||
      Number(w.maxAmount) > Number(w.minAmount),
    {
      message: 'Max amount must exceed min amount',
      path: ['maxAmount'],
    },
  );
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;

export const updateWorkflowSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
  minAmount: amountSchema.optional(),
  maxAmount: amountSchema.nullable().optional(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  allowSelfApproval: z.boolean().optional(),
  branchId: z.string().uuid().nullable().optional(),
  deadlineHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .nullable()
    .optional(),
  escalationPermission: z.string().trim().min(3).max(100).nullable().optional(),
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
  /** Only pending requests past their deadline. */
  overdue: z
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

// ------------------------------------------------ hardening: reconciliation

export const runReconciliationSchema = z.object({
  area: z.enum(RECONCILIATION_AREAS),
  asOf: isoDateSchema,
});
export type RunReconciliationInput = z.infer<typeof runReconciliationSchema>;

export const listReconciliationsQuerySchema = paginationQuerySchema.extend({
  area: z.enum(RECONCILIATION_AREAS).optional(),
  status: z.enum(SUBLEDGER_RECONCILIATION_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListReconciliationsQuery = z.infer<typeof listReconciliationsQuerySchema>;

export const assignReconciliationSchema = z.object({
  reviewerId: uuidSchema,
  notes: optionalText(1000),
});
export type AssignReconciliationInput = z.infer<typeof assignReconciliationSchema>;

export const reconciliationNotesSchema = z.object({
  notes: z.string().trim().min(1, 'Notes are required').max(2000),
});
export type ReconciliationNotesInput = z.infer<typeof reconciliationNotesSchema>;

/** An explained part of the variance (timing difference, posting error to be corrected, ...). */
export const createReconciliationExceptionSchema = z.object({
  description: z.string().trim().min(3, 'Describe the exception').max(500),
  /** Signed contribution to the variance (ledger minus subledger). */
  amount: amountSchema,
  reference: optionalText(100),
});
export type CreateReconciliationExceptionInput = z.infer<
  typeof createReconciliationExceptionSchema
>;

export const resolveReconciliationExceptionSchema = z.object({
  resolution: z.string().trim().min(3, 'Explain how it was resolved').max(1000),
});
export type ResolveReconciliationExceptionInput = z.infer<
  typeof resolveReconciliationExceptionSchema
>;

/** Close-blocker policy: which automatic checks must pass before approval / completion. */
export const closePolicySchema = z.object({
  closeRequireReconciliations: z.boolean().optional(),
  closeRequireBankReconciliation: z.boolean().optional(),
  closeRequireDepreciation: z.boolean().optional(),
  closeRequireFxRevaluation: z.boolean().optional(),
  closeRequireRevenueRecognition: z.boolean().optional(),
  closeRequirePayrollPosted: z.boolean().optional(),
  closeBlockOnUnapprovedJournals: z.boolean().optional(),
  closeBlockOnOpenExceptions: z.boolean().optional(),
  closeRequireIntegrityOk: z.boolean().optional(),
  closeLockOnComplete: z.boolean().optional(),
  /** A material or aged suspense balance blocks the close. */
  closeBlockOnSuspense: z.boolean().optional(),
});
export type ClosePolicyInput = z.infer<typeof closePolicySchema>;

/** Company accounting policies: what counts as material and what blocks a close. */
export const updateAccountingPolicySchema = closePolicySchema.extend({
  /** Absolute variance (base currency) up to which a reconciliation counts as reconciled. */
  reconciliationMateriality: amountSchema.optional(),
  /** A reconciliation older than this many days is considered stale. */
  reconciliationStaleDays: z.coerce.number().int().min(1).max(365).optional(),
  /** Absolute suspense balance (base currency) above which investigation is required. */
  suspenseMateriality: amountSchema.optional(),
  /** Days a suspense balance may stay open before investigation is required. */
  suspenseMaxAgeDays: z.coerce.number().int().min(1).max(365).optional(),
});
export type UpdateAccountingPolicyInput = z.infer<typeof updateAccountingPolicySchema>;

// ------------------------------------------------ hardening: financial close

export const startCloseSchema = z.object({
  fiscalPeriodId: uuidSchema,
  closeType: z.enum(CLOSE_TYPES).default('MONTH'),
});
export type StartCloseInput = z.infer<typeof startCloseSchema>;

export const listClosesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CLOSE_STATUSES).optional(),
  closeType: z.enum(CLOSE_TYPES).optional(),
});
export type ListClosesQuery = z.infer<typeof listClosesQuerySchema>;

/** Manual tasks are worked by people; AUTO tasks only accept owner / reviewer / notes. */
export const updateCloseTaskSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED']).optional(),
  ownerId: uuidSchema.nullable().optional(),
  reviewerId: uuidSchema.nullable().optional(),
  notes: optionalText(2000),
  /** Required when skipping a required task. */
  reason: optionalText(500),
});
export type UpdateCloseTaskInput = z.infer<typeof updateCloseTaskSchema>;

export const addCloseTaskSchema = z.object({
  title: nameSchema,
  required: z.boolean().default(true),
  ownerId: uuidSchema.optional(),
});
export type AddCloseTaskInput = z.infer<typeof addCloseTaskSchema>;

export const closeDecisionSchema = z.object({
  notes: optionalText(1000),
});
export type CloseDecisionInput = z.infer<typeof closeDecisionSchema>;

// ------------------------------------------------ hardening: enterprise controls

export const controlsQuerySchema = z.object({ asOf: isoDateSchema.optional() });
export type ControlsQuery = z.infer<typeof controlsQuerySchema>;

export const fieldHistoryQuerySchema = z.object({
  entityType: z.string().trim().min(1).max(100),
  entityId: z.string().uuid(),
  /** Restrict to one field. */
  field: z.string().trim().min(1).max(100).optional(),
});
export type FieldHistoryQuery = z.infer<typeof fieldHistoryQuerySchema>;
