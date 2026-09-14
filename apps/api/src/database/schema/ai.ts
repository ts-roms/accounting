import { sql } from 'drizzle-orm';
import {
  check,
  index,
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
  AI_ANOMALY_TYPES,
  AI_DOCUMENT_KINDS,
  AI_DOCUMENT_STATUSES,
  AI_MESSAGE_ROLES,
  AI_PROVIDERS,
  AI_SEVERITIES,
  AI_SUGGESTION_STATUSES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { expenseClaims } from './budgeting';
import { attachments } from './enterprise';
import { companies } from './organizations';
import { vendorBills, vendors } from './subledger';
import { users } from './users';

export const aiDocumentStatusEnum = pgEnum('ai_document_status', AI_DOCUMENT_STATUSES);
export const aiDocumentKindEnum = pgEnum('ai_document_kind', AI_DOCUMENT_KINDS);
export const aiSuggestionStatusEnum = pgEnum('ai_suggestion_status', AI_SUGGESTION_STATUSES);
export const aiAnomalyTypeEnum = pgEnum('ai_anomaly_type', AI_ANOMALY_TYPES);
export const aiSeverityEnum = pgEnum('ai_severity', AI_SEVERITIES);
export const aiProviderEnum = pgEnum('ai_provider', AI_PROVIDERS);
export const aiMessageRoleEnum = pgEnum('ai_message_role', AI_MESSAGE_ROLES);

/** 0..1 confidence reported by the extractor / classifier. */
const confidence = (name: string) => numeric(name, { precision: 5, scale: 4 });

// --------------------------------------------------------------------- intake

/**
 * A document dropped into the AI tray. The file itself is an ordinary
 * attachment (entity AI_DOCUMENT) that moves to the drafted bill / claim; the
 * row keeps the extracted fields and what became of them.
 */
export const aiDocuments = pgTable(
  'ai_documents',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    status: aiDocumentStatusEnum('status').notNull().default('EXTRACTED'),
    kind: aiDocumentKindEnum('kind').notNull().default('UNKNOWN'),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'set null' }),
    /** Text the extractor worked from (null for images the provider read directly). */
    sourceText: text('source_text'),
    extracted: jsonb('extracted').notNull().default({}),
    confidence: confidence('confidence').notNull().default('0'),
    provider: aiProviderEnum('provider').notNull().default('HEURISTIC'),
    model: text('model'),
    /** Reviewer-matched vendor for bills. */
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    draftBillId: uuid('draft_bill_id').references(() => vendorBills.id, { onDelete: 'set null' }),
    draftExpenseClaimId: uuid('draft_expense_claim_id').references(() => expenseClaims.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('ai_documents_company_status_idx').on(t.companyId, t.status, t.createdAt),
    check('ai_documents_confidence_chk', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
  ],
);

// ---------------------------------------------------------------- suggestions

/**
 * Anomaly flags and other suggestions awaiting a human decision. A fingerprint
 * keeps repeated scans from raising the same flag twice.
 */
export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    status: aiSuggestionStatusEnum('status').notNull().default('OPEN'),
    anomalyType: aiAnomalyTypeEnum('anomaly_type').notNull(),
    severity: aiSeverityEnum('severity').notNull().default('MEDIUM'),
    fingerprint: text('fingerprint').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityNumber: text('entity_number'),
    entityDate: text('entity_date'),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    payload: jsonb('payload').notNull().default({}),
    confidence: confidence('confidence').notNull().default('0.5'),
    provider: aiProviderEnum('provider').notNull().default('HEURISTIC'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('ai_suggestions_fingerprint_uq').on(t.companyId, t.fingerprint),
    index('ai_suggestions_company_status_idx').on(t.companyId, t.status, t.severity),
    index('ai_suggestions_entity_idx').on(t.entityType, t.entityId),
  ],
);

// ------------------------------------------------------------------ assistant

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    ...timestamps,
  },
  (t) => [index('ai_conversations_user_idx').on(t.companyId, t.userId, t.updatedAt)],
);

/** Every question and answer, with the report data the answer was built from. */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: primaryId(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    role: aiMessageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    /** Facts and report references the answer cites (empty for user messages). */
    sources: jsonb('sources').notNull().default([]),
    provider: aiProviderEnum('provider'),
    model: text('model'),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

export type AiDocument = typeof aiDocuments.$inferSelect;
export type AiSuggestion = typeof aiSuggestions.$inferSelect;
export type AiConversation = typeof aiConversations.$inferSelect;
export type AiMessage = typeof aiMessages.$inferSelect;
