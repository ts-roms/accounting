import { z } from 'zod';
import {
  DEFAULT_NUMBERING_FORMAT,
  DOCUMENT_TYPES,
  EXPORT_DATASETS,
  IMPORT_STATUSES,
  IMPORT_TYPES,
  OPENING_BALANCE_AREAS,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting.js';
import { optionalText, paginationQuerySchema, uuidSchema } from './primitives.js';

// ------------------------------------------------------------------ numbering

/** A numbering rule: how documents of one type (optionally per branch) are numbered. */
export const numberingRuleSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  /** Branch-specific override; null = company-wide rule. */
  branchId: uuidSchema.nullable().optional(),
  prefix: z
    .string()
    .trim()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9]+$/, 'Prefix must be upper-case letters and digits'),
  /** Template using {PREFIX}, {BRANCH}, {YEAR}, {YY} and {SEQ}; {SEQ} is required. */
  format: z
    .string()
    .trim()
    .min(5)
    .max(60)
    .default(DEFAULT_NUMBERING_FORMAT)
    .refine((f) => f.includes('{SEQ}'), 'The format must contain {SEQ}')
    .refine(
      (f) => /^(\{PREFIX\}|\{BRANCH\}|\{YEAR\}|\{YY\}|\{SEQ\}|[A-Z0-9/_.-])+$/.test(f),
      'Only tokens, upper-case letters, digits and - _ / . are allowed',
    ),
  padding: z.coerce.number().int().min(3).max(12).default(6),
  /** Restart the sequence every fiscal year (true) or keep one running counter (false). */
  resetYearly: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
export type NumberingRuleInput = z.infer<typeof numberingRuleSchema>;

export const numberingPreviewQuerySchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  branchId: uuidSchema.optional(),
  /** Defaults to the current year. */
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type NumberingPreviewQuery = z.infer<typeof numberingPreviewQuerySchema>;

// -------------------------------------------------------------------- imports

export const createImportSchema = z.object({
  type: z.enum(IMPORT_TYPES),
  /** Opening balances: the cut-over date every row is booked on. Journals: default entry date. */
  asOfDate: isoDateSchema.optional(),
  branchId: uuidSchema.nullable().optional(),
});
export type CreateImportInput = z.infer<typeof createImportSchema>;

export const listImportsQuerySchema = paginationQuerySchema.extend({
  type: z.enum(IMPORT_TYPES).optional(),
  status: z.enum(IMPORT_STATUSES).optional(),
});
export type ListImportsQuery = z.infer<typeof listImportsQuerySchema>;

export const commitImportSchema = z.object({
  /** Master data only: skip rows that failed validation instead of refusing the whole file. */
  skipInvalid: z.boolean().default(false),
});
export type CommitImportInput = z.infer<typeof commitImportSchema>;

// -------------------------------------------------------------------- exports

export const exportQuerySchema = z.object({
  dataset: z.enum(EXPORT_DATASETS),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  asOf: isoDateSchema.optional(),
  accountId: uuidSchema.optional(),
  status: z.string().trim().max(40).optional(),
  search: z.string().trim().max(200).optional(),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

// ----------------------------------------------------------- opening balances

/** One open customer / vendor item at the cut-over date. */
export const openingItemSchema = z.object({
  partyId: uuidSchema,
  /** The legacy document number, kept as the reference. */
  reference: z.string().trim().min(1).max(60),
  documentDate: isoDateSchema,
  dueDate: isoDateSchema.optional(),
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  description: optionalText(200),
});

export const openingSubledgerSchema = z.object({
  area: z.enum(['AR', 'AP']),
  asOfDate: isoDateSchema,
  branchId: uuidSchema.nullable().optional(),
  items: z.array(openingItemSchema).min(1).max(2000),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type OpeningSubledgerInput = z.infer<typeof openingSubledgerSchema>;

export const openingInventoryLineSchema = z.object({
  productId: uuidSchema,
  warehouseId: uuidSchema,
  quantity: amountSchema.refine((v) => Number(v) > 0, 'Quantity must be positive'),
  unitCost: amountSchema.refine((v) => Number(v) >= 0, 'Unit cost cannot be negative'),
  lotNumber: optionalText(60),
});

export const openingInventorySchema = z.object({
  asOfDate: isoDateSchema,
  branchId: uuidSchema.nullable().optional(),
  lines: z.array(openingInventoryLineSchema).min(1).max(2000),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type OpeningInventoryInput = z.infer<typeof openingInventorySchema>;

export const openingAssetSchema = z.object({
  categoryId: uuidSchema,
  name: z.string().trim().min(1).max(200),
  acquisitionDate: isoDateSchema,
  inServiceDate: isoDateSchema.optional(),
  acquisitionCost: amountSchema.refine((v) => Number(v) > 0, 'Cost must be positive'),
  /** Depreciation already taken before the cut-over. */
  accumulatedDepreciation: amountSchema.default('0'),
  salvageValue: amountSchema.default('0'),
  usefulLifeMonths: z.coerce.number().int().min(1).max(600).optional(),
  reference: optionalText(60),
  serialNumber: optionalText(100),
});

export const openingAssetsSchema = z.object({
  asOfDate: isoDateSchema,
  branchId: uuidSchema.nullable().optional(),
  assets: z.array(openingAssetSchema).min(1).max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type OpeningAssetsInput = z.infer<typeof openingAssetsSchema>;

export const openingReportQuerySchema = z.object({
  asOf: isoDateSchema,
  area: z.enum(OPENING_BALANCE_AREAS).optional(),
});
export type OpeningReportQuery = z.infer<typeof openingReportQuerySchema>;
