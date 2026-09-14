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
