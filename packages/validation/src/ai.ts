import { z } from 'zod';
import {
  AI_ANOMALY_TYPES,
  AI_CLASSIFY_SIDES,
  AI_DOCUMENT_KINDS,
  AI_DOCUMENT_STATUSES,
  AI_FORECAST_METRICS,
  AI_SEVERITIES,
  AI_SUGGESTION_STATUSES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import { optionalText, paginationQuerySchema, uuidSchema } from './primitives';

// --------------------------------------------------------------------- intake

/** A line the extractor found (or a reviewer typed) on an incoming document. */
export const aiExtractedLineSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: amountSchema.default('1'),
  unitPrice: amountSchema,
  /** Reviewer-chosen (or suggested) posting account; required before drafting. */
  accountId: uuidSchema.nullable().optional(),
  taxCodeId: uuidSchema.nullable().optional(),
});
export type AiExtractedLineInput = z.infer<typeof aiExtractedLineSchema>;

/** Fields the extractor fills and a reviewer may correct before drafting. */
export const aiExtractedFieldsSchema = z.object({
  vendorName: optionalText(200),
  vendorTaxId: optionalText(60),
  documentDate: isoDateSchema.nullable().optional(),
  dueDate: isoDateSchema.nullable().optional(),
  reference: optionalText(100),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  subtotal: amountSchema.nullable().optional(),
  taxAmount: amountSchema.nullable().optional(),
  total: amountSchema.nullable().optional(),
  lines: z.array(aiExtractedLineSchema).max(200).default([]),
});
export type AiExtractedFieldsInput = z.infer<typeof aiExtractedFieldsSchema>;

export const aiIntakeMetaSchema = z.object({
  kind: z.enum(AI_DOCUMENT_KINDS).optional(),
});
export type AiIntakeMetaInput = z.infer<typeof aiIntakeMetaSchema>;

export const updateAiDocumentSchema = z.object({
  kind: z.enum(AI_DOCUMENT_KINDS).optional(),
  extracted: aiExtractedFieldsSchema.optional(),
  /** Matched master-data party (bills). */
  vendorId: uuidSchema.nullable().optional(),
});
export type UpdateAiDocumentInput = z.infer<typeof updateAiDocumentSchema>;

/** Turn a reviewed intake document into a DRAFT bill or expense claim. */
export const draftFromAiDocumentSchema = z.object({
  kind: z.enum(['BILL', 'EXPENSE_CLAIM']),
  vendorId: uuidSchema.optional(),
  claimantUserId: uuidSchema.optional(),
  branchId: uuidSchema.nullable().optional(),
});
export type DraftFromAiDocumentInput = z.infer<typeof draftFromAiDocumentSchema>;

export const listAiDocumentsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(AI_DOCUMENT_STATUSES).optional(),
  kind: z.enum(AI_DOCUMENT_KINDS).optional(),
});
export type ListAiDocumentsQuery = z.infer<typeof listAiDocumentsQuerySchema>;

// ------------------------------------------------------------- classification

export const aiClassifySchema = z.object({
  description: z.string().trim().min(2).max(300),
  side: z.enum(AI_CLASSIFY_SIDES).default('PURCHASE'),
  partyId: uuidSchema.optional(),
  amount: amountSchema.optional(),
  limit: z.coerce.number().int().min(1).max(10).default(3),
});
export type AiClassifyInput = z.infer<typeof aiClassifySchema>;

// ------------------------------------------------------------------ anomalies

export const aiAnomalyScanSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
  })
  .refine((r) => r.from <= r.to, { message: 'from must not be after to', path: ['to'] });
export type AiAnomalyScanInput = z.infer<typeof aiAnomalyScanSchema>;

export const listAiAnomaliesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(AI_SUGGESTION_STATUSES).optional(),
  severity: z.enum(AI_SEVERITIES).optional(),
  anomalyType: z.enum(AI_ANOMALY_TYPES).optional(),
});
export type ListAiAnomaliesQuery = z.infer<typeof listAiAnomaliesQuerySchema>;

export const decideAiSuggestionSchema = z.object({
  decision: z.enum(['ACCEPT', 'DISMISS']),
  note: optionalText(500),
});
export type DecideAiSuggestionInput = z.infer<typeof decideAiSuggestionSchema>;

// ------------------------------------------------------------------ assistant

export const aiAskSchema = z.object({
  question: z.string().trim().min(2, 'Ask something').max(1000),
  conversationId: uuidSchema.optional(),
});
export type AiAskInput = z.infer<typeof aiAskSchema>;

export const aiForecastQuerySchema = z.object({
  metric: z.enum(AI_FORECAST_METRICS).default('REVENUE'),
  /** Months of history the model learns from. */
  history: z.coerce.number().int().min(3).max(36).default(12),
  /** Months projected. */
  horizon: z.coerce.number().int().min(1).max(12).default(6),
});
export type AiForecastQuery = z.infer<typeof aiForecastQuerySchema>;
