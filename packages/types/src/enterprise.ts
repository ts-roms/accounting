/** Phase 8 - multi-currency, consolidation / intercompany, approval workflows, documents. */

// ------------------------------------------------------------ multi-currency

export const EXCHANGE_RATE_SOURCES = ['MANUAL', 'IMPORT', 'SYSTEM'] as const;
export type ExchangeRateSource = (typeof EXCHANGE_RATE_SOURCES)[number];

/**
 * Which monetary item an FX adjustment touched: open receivables, open payables,
 * foreign-currency bank balances, foreign-currency lease liabilities.
 */
export const FX_SIDES = ['AR', 'AP', 'BANK', 'LEASE'] as const;
export type FxSide = (typeof FX_SIDES)[number];

export const FX_ADJUSTMENT_TYPES = ['REALIZED', 'REVALUATION', 'REVALUATION_REVERSAL'] as const;
export type FxAdjustmentType = (typeof FX_ADJUSTMENT_TYPES)[number];

// ---------------------------------------------------------------- intercompany

export const INTERCOMPANY_STATUSES = ['DRAFT', 'POSTED', 'SETTLED', 'REVERSED'] as const;
export type IntercompanyStatus = (typeof INTERCOMPANY_STATUSES)[number];

// ------------------------------------------------------------------ workflows

/** Document families an approval workflow can govern. */
export const WORKFLOW_DOCUMENT_TYPES = [
  'JOURNAL_ENTRY',
  'VENDOR_PAYMENT',
  'PURCHASE_ORDER',
  'EXPENSE_CLAIM',
  'VENDOR_BILL',
  'SALES_ORDER',
  'INVOICE',
  'CUSTOMER_PAYMENT',
  'CUSTOMER_REFUND',
  'WRITE_OFF',
  'PAYMENT_RUN',
  'VENDOR',
  'BANK_TRANSFER',
  'PETTY_CASH_VOUCHER',
  'CONSOLIDATION_RUN',
  'PAY_RUN',
  'PAYMENT_FILE',
] as const;
export type WorkflowDocumentType = (typeof WORKFLOW_DOCUMENT_TYPES)[number];

export const APPROVAL_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const APPROVAL_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// ------------------------------------------------------------------ documents

/** Entities that can carry attachments. */
export const ATTACHMENT_ENTITY_TYPES = [
  'JOURNAL_ENTRY',
  'INVOICE',
  'BILL',
  'CUSTOMER_PAYMENT',
  'VENDOR_PAYMENT',
  'EXPENSE_CLAIM',
  'FIXED_ASSET',
  'BANK_STATEMENT',
  'ORDER',
  'CUSTOMER',
  'VENDOR',
  'AI_DOCUMENT',
  'RECONCILIATION',
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export const ATTACHMENT_ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/csv',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

// ------------------------------------------------ hardening: reconciliation

/** Subledgers that reconcile to a control account (bank reconciliation lives in banking). */
export const RECONCILIATION_AREAS = ['AR', 'AP', 'INVENTORY', 'FIXED_ASSETS', 'TAX'] as const;
export type ReconciliationArea = (typeof RECONCILIATION_AREAS)[number];

/**
 * NOT_STARTED -> IN_PROGRESS (computed) -> RECONCILED | HAS_VARIANCE ->
 * UNDER_REVIEW (reviewer assigned) -> APPROVED. A material variance can only
 * be approved once every exception explaining it is resolved.
 */
export const SUBLEDGER_RECONCILIATION_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'RECONCILED',
  'HAS_VARIANCE',
  'UNDER_REVIEW',
  'APPROVED',
] as const;
export type SubledgerReconciliationStatus = (typeof SUBLEDGER_RECONCILIATION_STATUSES)[number];

export const RECONCILIATION_EXCEPTION_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type ReconciliationExceptionStatus = (typeof RECONCILIATION_EXCEPTION_STATUSES)[number];

// ------------------------------------------------ hardening: financial close

export const CLOSE_TYPES = ['MONTH', 'QUARTER', 'YEAR'] as const;
export type CloseType = (typeof CLOSE_TYPES)[number];

/** IN_PROGRESS -> READY (all required tasks done, no blockers) -> APPROVED -> COMPLETED (period closed / locked). */
export const CLOSE_STATUSES = [
  'IN_PROGRESS',
  'READY',
  'APPROVED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];

export const CLOSE_TASK_KINDS = ['AUTO', 'MANUAL'] as const;
export type CloseTaskKind = (typeof CLOSE_TASK_KINDS)[number];

export const CLOSE_TASK_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'SKIPPED',
  'BLOCKED',
] as const;
export type CloseTaskStatus = (typeof CLOSE_TASK_STATUSES)[number];

/** Checks the system evaluates itself; manual tasks are whatever the template says. */
export const CLOSE_AUTO_CHECKS = [
  'BANK_RECONCILIATION',
  'AR_RECONCILIATION',
  'AP_RECONCILIATION',
  'INVENTORY_RECONCILIATION',
  'FIXED_ASSET_RECONCILIATION',
  'TAX_RECONCILIATION',
  'DEPRECIATION',
  'FX_REVALUATION',
  'UNAPPROVED_JOURNALS',
  'OPEN_RECONCILIATION_EXCEPTIONS',
  'TRIAL_BALANCE',
  'INTEGRITY',
  'SUSPENSE_BALANCES',
  /** Every pay run whose period ends in the fiscal period is posted (Prompt #11). */
  'PAYROLL_POSTED',
  /** No deferred revenue due in the period is still waiting for a recognition run (Prompt #10). */
  'REVENUE_RECOGNITION',
  /** Every active finance lease has its interest and depreciation posted through the period end (Prompt #13). */
  'LEASE_RUNS_POSTED',
] as const;
export type CloseAutoCheck = (typeof CLOSE_AUTO_CHECKS)[number];

// ------------------------------------------------------------------ enterprise controls (H5)

/** Suspense / clearing account monitor status, decided by company policy. */
export const SUSPENSE_STATUSES = ['CLEAR', 'WITHIN_POLICY', 'REQUIRES_INVESTIGATION'] as const;
export type SuspenseStatus = (typeof SUSPENSE_STATUSES)[number];

// ------------------------------------------------------------------ data infrastructure (H6)

/** Datasets a CSV import can load. */
export const IMPORT_TYPES = [
  'CHART_OF_ACCOUNTS',
  'CUSTOMERS',
  'VENDORS',
  'PRODUCTS',
  'OPENING_BALANCES',
  'JOURNAL_ENTRIES',
  'BANK_TRANSACTIONS',
] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export const IMPORT_STATUSES = ['VALIDATED', 'COMMITTED', 'FAILED', 'CANCELLED'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Datasets that can be exported as CSV. */
export const EXPORT_DATASETS = [
  'TRIAL_BALANCE',
  'GENERAL_LEDGER',
  'JOURNAL_ENTRIES',
  'CHART_OF_ACCOUNTS',
  'CUSTOMERS',
  'VENDORS',
  'AR_AGING',
  'AP_AGING',
  'AUDIT_LOGS',
] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/** Tokens a numbering format may contain. */
export const NUMBERING_TOKENS = ['{PREFIX}', '{BRANCH}', '{YEAR}', '{YY}', '{SEQ}'] as const;
export const DEFAULT_NUMBERING_FORMAT = '{PREFIX}-{YEAR}-{SEQ}';

/** Subledger areas an opening balance can be loaded into. */
export const OPENING_BALANCE_AREAS = ['AR', 'AP', 'INVENTORY', 'FIXED_ASSETS'] as const;
export type OpeningBalanceArea = (typeof OPENING_BALANCE_AREAS)[number];

// ------------------------------------------------------------------ reporting engine (H7)

/** How a report column derives its date window from the run's current period. */
export const REPORT_COLUMN_KINDS = [
  'CURRENT',
  'PRIOR_PERIOD',
  'YEAR_TO_DATE',
  'PRIOR_YEAR',
  'BUDGET',
  'VARIANCE',
  'VARIANCE_PCT',
  'CUSTOM_RANGE',
] as const;
export type ReportColumnKind = (typeof REPORT_COLUMN_KINDS)[number];

export const REPORT_ROW_KINDS = ['HEADER', 'ACCOUNTS', 'FORMULA', 'DIMENSION_GROUP'] as const;
export type ReportRowKind = (typeof REPORT_ROW_KINDS)[number];

/** PERIOD rows report movement in the window; AS_OF rows report the balance at the window end. */
export const REPORT_BASES = ['PERIOD', 'AS_OF'] as const;
export type ReportBasis = (typeof REPORT_BASES)[number];

export const REPORT_CATEGORIES = ['FINANCIAL', 'MANAGEMENT', 'CUSTOM'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/** Presentation sign of a row: the account's natural side, or forced debit / credit positive. */
export const REPORT_SIGNS = ['NATURAL', 'DEBIT', 'CREDIT'] as const;
export type ReportSign = (typeof REPORT_SIGNS)[number];

// ------------------------------------------------------- operations (H8)

export const JOB_RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED_LOCKED'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export const JOB_TRIGGERS = ['SCHEDULED', 'MANUAL', 'STARTUP'] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

export const INTEGRITY_RUN_STATUSES = ['OK', 'WARNING', 'CRITICAL', 'FAILED'] as const;
export type IntegrityRunStatus = (typeof INTEGRITY_RUN_STATUSES)[number];
