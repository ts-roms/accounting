/** Phase 7 - budgeting, cost dimensions, tax engine, expense claims. */

// ------------------------------------------------------------- dimensions

export const DIMENSION_TYPES = ['DEPARTMENT', 'COST_CENTER', 'PROJECT'] as const;
export type DimensionType = (typeof DIMENSION_TYPES)[number];

/** Column names on journal / document lines, keyed by dimension type. */
export const DIMENSION_FIELDS = {
  DEPARTMENT: 'departmentId',
  COST_CENTER: 'costCenterId',
  PROJECT: 'projectId',
} as const satisfies Record<DimensionType, string>;
export type DimensionField = (typeof DIMENSION_FIELDS)[DimensionType];

// ---------------------------------------------------------------- budgets

export const BUDGET_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/** A version is editable while DRAFT; approving locks its lines and makes it the version actuals compare against. */
export const BUDGET_VERSION_STATUSES = ['DRAFT', 'APPROVED', 'SUPERSEDED'] as const;
export type BudgetVersionStatus = (typeof BUDGET_VERSION_STATUSES)[number];

// -------------------------------------------------------------------- tax

/** SALES_TAX: VAT / GST style tax added to the document. WITHHOLDING: deducted from what the counterparty is paid. */
export const TAX_KINDS = ['SALES_TAX', 'WITHHOLDING'] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

export const TAX_SIDES = ['SALES', 'PURCHASES'] as const;
export type TaxSide = (typeof TAX_SIDES)[number];

export const TAX_APPLIES_TO = ['SALES', 'PURCHASES', 'BOTH'] as const;
export type TaxAppliesTo = (typeof TAX_APPLIES_TO)[number];

/** Reporting bucket for tax returns; free of jurisdiction rules but shaped for VAT-style returns. */
export const TAX_REPORTING_CATEGORIES = ['TAXABLE', 'ZERO_RATED', 'EXEMPT', 'WITHHOLDING'] as const;
export type TaxReportingCategory = (typeof TAX_REPORTING_CATEGORIES)[number];

export const TAX_SOURCE_TYPES = ['AR_DOCUMENT', 'AP_DOCUMENT', 'EXPENSE_CLAIM'] as const;
export type TaxSourceType = (typeof TAX_SOURCE_TYPES)[number];

// ---------------------------------------------------------- expense claims

export const EXPENSE_CLAIM_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'POSTED',
  'PAID',
  'CANCELLED',
] as const;
export type ExpenseClaimStatus = (typeof EXPENSE_CLAIM_STATUSES)[number];
