/** Phase 8 - multi-currency, consolidation / intercompany, approval workflows, documents. */

// ------------------------------------------------------------ multi-currency

export const EXCHANGE_RATE_SOURCES = ['MANUAL', 'IMPORT', 'SYSTEM'] as const;
export type ExchangeRateSource = (typeof EXCHANGE_RATE_SOURCES)[number];

/** Which subledger an FX adjustment touched. */
export const FX_SIDES = ['AR', 'AP'] as const;
export type FxSide = (typeof FX_SIDES)[number];

export const FX_ADJUSTMENT_TYPES = ['REALIZED', 'REVALUATION', 'REVALUATION_REVERSAL'] as const;
export type FxAdjustmentType = (typeof FX_ADJUSTMENT_TYPES)[number];

// ---------------------------------------------------------------- intercompany

export const INTERCOMPANY_STATUSES = ['DRAFT', 'POSTED', 'REVERSED'] as const;
export type IntercompanyStatus = (typeof INTERCOMPANY_STATUSES)[number];

// ------------------------------------------------------------------ workflows

/** Document families an approval workflow can govern. */
export const WORKFLOW_DOCUMENT_TYPES = [
  'JOURNAL_ENTRY',
  'VENDOR_PAYMENT',
  'PURCHASE_ORDER',
  'EXPENSE_CLAIM',
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
export const CLOSE_STATUSES = ['IN_PROGRESS', 'READY', 'APPROVED', 'COMPLETED', 'CANCELLED'] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];

export const CLOSE_TASK_KINDS = ['AUTO', 'MANUAL'] as const;
export type CloseTaskKind = (typeof CLOSE_TASK_KINDS)[number];

export const CLOSE_TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED', 'BLOCKED'] as const;
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
] as const;
export type CloseAutoCheck = (typeof CLOSE_AUTO_CHECKS)[number];
