import { z } from 'zod';
import {
  BUDGET_STATUSES,
  BUDGET_VERSION_STATUSES,
  DIMENSION_TYPES,
  ENTITY_STATUSES,
  EXPENSE_CLAIM_STATUSES,
  TAX_APPLIES_TO,
  TAX_KINDS,
  TAX_REPORTING_CATEGORIES,
  TAX_SIDES,
  TAX_SOURCE_TYPES,
} from '@accounting/types';
import { amountSchema, isoDateSchema, signedAmountSchema } from './accounting.js';
import {
  codeSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  uuidSchema,
} from './primitives.js';
import { dimensionRefsSchema, lineTaxSchema } from './dimensions.js';
import { percentSchema } from './subledger.js';

// ------------------------------------------------------------- dimensions

export const createDimensionSchema = z.object({
  dimensionType: z.enum(DIMENSION_TYPES),
  code: codeSchema,
  name: nameSchema,
  description: optionalText(500),
  parentId: uuidSchema.nullable().optional(),
  /** Projects: optional lifetime; other types ignore these. */
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  managerUserId: uuidSchema.nullable().optional(),
});
export type CreateDimensionInput = z.infer<typeof createDimensionSchema>;
export const updateDimensionSchema = createDimensionSchema
  .omit({ dimensionType: true, code: true })
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateDimensionInput = z.infer<typeof updateDimensionSchema>;

export const listDimensionsQuerySchema = z.object({
  dimensionType: z.enum(DIMENSION_TYPES).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});
export type ListDimensionsQuery = z.infer<typeof listDimensionsQuerySchema>;

// ---------------------------------------------------------------- budgets

export const createBudgetSchema = z.object({
  fiscalYearId: uuidSchema,
  code: codeSchema,
  name: nameSchema,
  description: optionalText(1000),
});
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;
export const updateBudgetSchema = createBudgetSchema
  .omit({ fiscalYearId: true })
  .partial()
  .extend({ status: z.enum(BUDGET_STATUSES).optional() });
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

export const listBudgetsQuerySchema = paginationQuerySchema.extend({
  fiscalYearId: uuidSchema.optional(),
  status: z.enum(BUDGET_STATUSES).optional(),
});
export type ListBudgetsQuery = z.infer<typeof listBudgetsQuerySchema>;

export const createBudgetVersionSchema = z.object({
  name: nameSchema,
  notes: optionalText(1000),
  /** Copy the lines of this version as the starting point. */
  copyFromVersionId: uuidSchema.optional(),
});
export type CreateBudgetVersionInput = z.infer<typeof createBudgetVersionSchema>;

export const budgetLineInputSchema = dimensionRefsSchema.extend({
  accountId: uuidSchema,
  fiscalPeriodId: uuidSchema,
  amount: signedAmountSchema,
  notes: optionalText(300),
});
export type BudgetLineInput = z.infer<typeof budgetLineInputSchema>;

/** Replaces every line of a draft version. */
export const replaceBudgetLinesSchema = z.object({
  lines: z.array(budgetLineInputSchema).max(20000),
});
export type ReplaceBudgetLinesInput = z.infer<typeof replaceBudgetLinesSchema>;

export const varianceQuerySchema = dimensionRefsSchema.extend({
  /** Restrict to these account types; default revenue + expense. */
  accountId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  /** Up to and including this period (default: whole year). */
  toPeriodId: uuidSchema.optional(),
});
export type VarianceQuery = z.infer<typeof varianceQuerySchema>;

export const budgetVersionStatusSchema = z.enum(BUDGET_VERSION_STATUSES);

// -------------------------------------------------------------------- tax

export const taxRateInputSchema = z.object({
  ratePercent: percentSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable().optional(),
});
export type TaxRateInput = z.infer<typeof taxRateInputSchema>;

export const createTaxCodeSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    description: optionalText(500),
    kind: z.enum(TAX_KINDS),
    appliesTo: z.enum(TAX_APPLIES_TO),
    reportingCategory: z.enum(TAX_REPORTING_CATEGORIES),
    /** Account credited (sales tax) or debited (withholding) on the sales side: output tax payable / creditable withholding receivable. */
    salesAccountId: uuidSchema.nullable().optional(),
    /** Account debited (sales tax) or credited (withholding) on the purchase side: input tax receivable / withholding tax payable. */
    purchaseAccountId: uuidSchema.nullable().optional(),
    isDefaultSales: z.boolean().default(false),
    isDefaultPurchases: z.boolean().default(false),
    rates: z.array(taxRateInputSchema).min(1, 'At least one rate is required').max(50),
  })
  .refine((c) => c.appliesTo === 'PURCHASES' || c.salesAccountId, {
    message: 'A sales-side account is required',
    path: ['salesAccountId'],
  })
  .refine((c) => c.appliesTo === 'SALES' || c.purchaseAccountId, {
    message: 'A purchase-side account is required',
    path: ['purchaseAccountId'],
  });
export type CreateTaxCodeInput = z.infer<typeof createTaxCodeSchema>;

export const updateTaxCodeSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
  reportingCategory: z.enum(TAX_REPORTING_CATEGORIES).optional(),
  salesAccountId: uuidSchema.nullable().optional(),
  purchaseAccountId: uuidSchema.nullable().optional(),
  isDefaultSales: z.boolean().optional(),
  isDefaultPurchases: z.boolean().optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
  /** Full replacement of the rate history when present. */
  rates: z.array(taxRateInputSchema).min(1).max(50).optional(),
});
export type UpdateTaxCodeInput = z.infer<typeof updateTaxCodeSchema>;

export const listTaxCodesQuerySchema = z.object({
  side: z.enum(TAX_SIDES).optional(),
  kind: z.enum(TAX_KINDS).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});
export type ListTaxCodesQuery = z.infer<typeof listTaxCodesQuerySchema>;

export const listTaxTransactionsQuerySchema = paginationQuerySchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  taxCodeId: uuidSchema.optional(),
  side: z.enum(TAX_SIDES).optional(),
  sourceType: z.enum(TAX_SOURCE_TYPES).optional(),
  partyId: uuidSchema.optional(),
});
export type ListTaxTransactionsQuery = z.infer<typeof listTaxTransactionsQuerySchema>;

export const taxReportQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  side: z.enum(TAX_SIDES).optional(),
});
export type TaxReportQuery = z.infer<typeof taxReportQuerySchema>;

// ---------------------------------------------------------- expense claims

export const expenseClaimLineSchema = dimensionRefsSchema.merge(lineTaxSchema).extend({
  expenseDate: isoDateSchema,
  description: z.string().trim().min(1, 'Description is required').max(300),
  accountId: uuidSchema,
  /** Gross amount paid by the employee, including any sales tax. */
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  receiptReference: optionalText(100),
  merchant: optionalText(150),
});
export type ExpenseClaimLineInput = z.infer<typeof expenseClaimLineSchema>;

export const createExpenseClaimSchema = z.object({
  /** Defaults to the acting user. */
  claimantUserId: uuidSchema.optional(),
  claimDate: isoDateSchema,
  purpose: z.string().trim().min(1, 'Purpose is required').max(300),
  notes: optionalText(1000),
  branchId: uuidSchema.nullable().optional(),
  lines: z.array(expenseClaimLineSchema).min(1, 'At least one line is required').max(200),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateExpenseClaimInput = z.infer<typeof createExpenseClaimSchema>;
export const updateExpenseClaimSchema = createExpenseClaimSchema
  .omit({ idempotencyKey: true, claimantUserId: true })
  .partial();
export type UpdateExpenseClaimInput = z.infer<typeof updateExpenseClaimSchema>;

export const listExpenseClaimsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(EXPENSE_CLAIM_STATUSES).optional(),
  claimantUserId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListExpenseClaimsQuery = z.infer<typeof listExpenseClaimsQuerySchema>;

export const rejectExpenseClaimSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type RejectExpenseClaimInput = z.infer<typeof rejectExpenseClaimSchema>;

export const payExpenseClaimSchema = z.object({
  bankAccountId: uuidSchema,
  paymentDate: isoDateSchema,
  reference: optionalText(100),
});
export type PayExpenseClaimInput = z.infer<typeof payExpenseClaimSchema>;
