import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  ATTACHMENT_ENTITY_TYPES,
  EXCHANGE_RATE_SOURCES,
  FX_ADJUSTMENT_TYPES,
  FX_SIDES,
  INTERCOMPANY_STATUSES,
  WORKFLOW_DOCUMENT_TYPES,
} from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { branches, companies, organizations } from './organizations';
import { users } from './users';

export const exchangeRateSourceEnum = pgEnum('exchange_rate_source', EXCHANGE_RATE_SOURCES);
export const fxSideEnum = pgEnum('fx_side', FX_SIDES);
export const fxAdjustmentTypeEnum = pgEnum('fx_adjustment_type', FX_ADJUSTMENT_TYPES);
export const intercompanyStatusEnum = pgEnum('intercompany_status', INTERCOMPANY_STATUSES);
export const workflowDocumentTypeEnum = pgEnum('workflow_document_type', WORKFLOW_DOCUMENT_TYPES);
export const approvalRequestStatusEnum = pgEnum(
  'approval_request_status',
  APPROVAL_REQUEST_STATUSES,
);
export const approvalDecisionEnum = pgEnum('approval_decision', APPROVAL_DECISIONS);
export const attachmentEntityTypeEnum = pgEnum('attachment_entity_type', ATTACHMENT_ENTITY_TYPES);

/** Rates carry more precision than money: 1 `from` = `rate` x `to`. */
export const rate = (name: string) => numeric(name, { precision: 19, scale: 8 });

// ------------------------------------------------------------- multi-currency

/** Organization-wide rate table; the rate in force on a date is the latest on or before it. */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    fromCurrency: char('from_currency', { length: 3 }).notNull(),
    toCurrency: char('to_currency', { length: 3 }).notNull(),
    rateDate: date('rate_date').notNull(),
    rate: rate('rate').notNull(),
    source: exchangeRateSourceEnum('source').notNull().default('MANUAL'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('exchange_rates_pair_date_uq').on(
      t.organizationId,
      t.fromCurrency,
      t.toCurrency,
      t.rateDate,
    ),
    check('exchange_rates_rate_chk', sql`${t.rate} > 0 AND ${t.fromCurrency} <> ${t.toCurrency}`),
  ],
);

/**
 * Every FX effect on a control account, realized or unrealized. The subledger
 * reconciliation adds these to document / payment base amounts so the
 * receivable / payable control ties exactly even with foreign-currency items.
 * `amount` is the signed effect on the control account (positive = debit).
 */
export const fxAdjustments = pgTable(
  'fx_adjustments',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    side: fxSideEnum('side').notNull(),
    adjustmentType: fxAdjustmentTypeEnum('adjustment_type').notNull(),
    adjustmentDate: date('adjustment_date').notNull(),
    amount: money('amount').notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'restrict' }),
    /** Payment / document / revaluation the adjustment belongs to. */
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('fx_adjustments_company_side_idx').on(t.companyId, t.side, t.adjustmentDate),
    index('fx_adjustments_source_idx').on(t.sourceType, t.sourceId),
  ],
);

export const fxRevaluations = pgTable(
  'fx_revaluations',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    runNumber: text('run_number').notNull(),
    asOfDate: date('as_of_date').notNull(),
    reversalDate: date('reversal_date').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Per open item: what was revalued and by how much. */
    lines: jsonb('lines')
      .$type<
        Array<{
          side: 'AR' | 'AP';
          documentId: string;
          documentNumber: string;
          currency: string;
          openAmount: string;
          documentRate: string;
          closingRate: string;
          adjustment: string;
        }>
      >()
      .notNull()
      .default([]),
    unrealizedGain: money('unrealized_gain').notNull().default('0'),
    unrealizedLoss: money('unrealized_loss').notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('fx_revaluations_company_number_uq').on(t.companyId, t.runNumber),
    index('fx_revaluations_company_date_idx').on(t.companyId, t.asOfDate),
  ],
);

// ---------------------------------------------------------------- intercompany

/**
 * One business event recorded in two companies of the organization in one
 * transaction: the originating company debits an account and credits the
 * intercompany payable; the receiving company debits the intercompany
 * receivable and credits an account. Consolidation eliminates the mirrored pair.
 */
export const intercompanyTransactions = pgTable(
  'intercompany_transactions',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    fromCompanyId: uuid('from_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    toCompanyId: uuid('to_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    transactionDate: date('transaction_date').notNull(),
    description: text('description').notNull(),
    reference: text('reference'),
    currency: char('currency', { length: 3 }).notNull(),
    amount: money('amount').notNull(),
    fromAccountId: uuid('from_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    toAccountId: uuid('to_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    status: intercompanyStatusEnum('status').notNull().default('DRAFT'),
    fromJournalEntryId: uuid('from_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    toJournalEntryId: uuid('to_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    /** Settlement (Prompt #9): cash from the originating company's bank to the receiving company's bank. */
    settlementDate: date('settlement_date'),
    settlementFromJournalEntryId: uuid('settlement_from_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    settlementToJournalEntryId: uuid('settlement_to_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'restrict' },
    ),
    settledBy: uuid('settled_by').references(() => users.id, { onDelete: 'set null' }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    // Numbers come from the originating company's ICT sequence (Prompt #9: per-company, like every other document).
    uniqueIndex('intercompany_company_number_uq').on(t.fromCompanyId, t.documentNumber),
    uniqueIndex('intercompany_idempotency_uq').on(t.organizationId, t.idempotencyKey),
    index('intercompany_from_idx').on(t.fromCompanyId, t.transactionDate),
    index('intercompany_to_idx').on(t.toCompanyId, t.transactionDate),
    check(
      'intercompany_amount_chk',
      sql`${t.amount} > 0 AND ${t.fromCompanyId} <> ${t.toCompanyId}`,
    ),
  ],
);

// ------------------------------------------------------------------ workflows

export interface WorkflowStep {
  name: string;
  requiredPermission: string;
  minApprovers: number;
}

/** Configurable multi-step approval chains, matched by document type and amount band. */
export const approvalWorkflows = pgTable(
  'approval_workflows',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentType: workflowDocumentTypeEnum('document_type').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    minAmount: money('min_amount').notNull().default('0'),
    maxAmount: money('max_amount'),
    priority: integer('priority').notNull().default(100),
    allowSelfApproval: boolean('allow_self_approval').notNull().default(false),
    /** Restricts the workflow to documents of one branch; NULL = every branch. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    /** Hours a request may stay pending before it is overdue. */
    deadlineHours: integer('deadline_hours'),
    /** Holders of this permission may decide an overdue request in place of the step approvers. */
    escalationPermission: text('escalation_permission'),
    steps: jsonb('steps').$type<WorkflowStep[]>().notNull().default([]),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('approval_workflows_company_type_idx').on(t.companyId, t.documentType, t.status),
    check(
      'approval_workflows_band_chk',
      sql`${t.minAmount} >= 0 AND (${t.maxAmount} IS NULL OR ${t.maxAmount} > ${t.minAmount})`,
    ),
  ],
);

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => approvalWorkflows.id, { onDelete: 'restrict' }),
    documentType: workflowDocumentTypeEnum('document_type').notNull(),
    documentId: uuid('document_id').notNull(),
    documentNumber: text('document_number').notNull(),
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Snapshot of the workflow steps at request time (workflow edits never change open requests). */
    steps: jsonb('steps').$type<WorkflowStep[]>().notNull(),
    currentStep: integer('current_step').notNull().default(0),
    status: approvalRequestStatusEnum('status').notNull().default('PENDING'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    /** Deadline copied from the workflow at request time; NULL = no deadline. */
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** Set when the request was found overdue and opened to the escalation approvers. */
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('approval_requests_document_idx').on(t.documentType, t.documentId),
    index('approval_requests_company_status_idx').on(t.companyId, t.status),
    // One open request per document.
    uniqueIndex('approval_requests_open_uq')
      .on(t.documentType, t.documentId)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: primaryId(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    step: integer('step').notNull(),
    decision: approvalDecisionEnum('decision').notNull(),
    comment: text('comment'),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('approval_decisions_request_idx').on(t.requestId, t.step),
    uniqueIndex('approval_decisions_user_step_uq').on(t.requestId, t.step, t.decidedBy),
  ],
);

// ------------------------------------------------------------------ documents

/** File metadata; bytes live in the configured storage directory under `storage_key`. */
export const attachments = pgTable(
  'attachments',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    entityType: attachmentEntityTypeEnum('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    description: text('description'),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('attachments_entity_idx').on(t.entityType, t.entityId),
    index('attachments_company_idx').on(t.companyId, t.createdAt),
    check('attachments_size_chk', sql`${t.sizeBytes} > 0`),
  ],
);

export type ExchangeRate = typeof exchangeRates.$inferSelect;
export type FxAdjustment = typeof fxAdjustments.$inferSelect;
export type FxRevaluation = typeof fxRevaluations.$inferSelect;
export type IntercompanyTransaction = typeof intercompanyTransactions.$inferSelect;
export type ApprovalWorkflow = typeof approvalWorkflows.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type ApprovalDecisionRow = typeof approvalDecisions.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
