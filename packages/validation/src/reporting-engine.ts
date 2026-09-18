import { z } from 'zod';
import {
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  DIMENSION_TYPES,
  ENTITY_STATUSES,
  REPORT_BASES,
  REPORT_CATEGORIES,
  REPORT_COLUMN_KINDS,
  REPORT_ROW_KINDS,
  REPORT_SIGNS,
} from '@accounting/types';
import { isoDateSchema } from './accounting.js';
import { dimensionRefsSchema } from './dimensions.js';
import {
  codeSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  uuidSchema,
} from './primitives.js';

// ------------------------------------------------------------ definitions

const rowKey = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Row keys are UPPER_SNAKE_CASE');

/** Which accounts a row aggregates; every listed criterion is a union. */
export const accountSelectorSchema = z
  .object({
    accountIds: z.array(uuidSchema).max(200).optional(),
    codes: z.array(z.string().trim().min(1).max(40)).max(200).optional(),
    /** Inclusive code range, compared as strings (chart codes are zero-padded). */
    codeFrom: z.string().trim().min(1).max(40).optional(),
    codeTo: z.string().trim().min(1).max(40).optional(),
    types: z.array(z.enum(ACCOUNT_TYPES)).optional(),
    subtypes: z.array(z.enum(ACCOUNT_SUBTYPES)).optional(),
    mappingKeys: z.array(z.enum(ACCOUNT_MAPPING_KEYS)).optional(),
  })
  .refine(
    (s) =>
      Boolean(
        s.accountIds?.length ||
        s.codes?.length ||
        (s.codeFrom && s.codeTo) ||
        s.types?.length ||
        s.subtypes?.length ||
        s.mappingKeys?.length,
      ),
    'An account selector needs at least one criterion',
  );
export type AccountSelector = z.infer<typeof accountSelectorSchema>;

export const reportRowSchema = z
  .object({
    key: rowKey,
    label: z.string().trim().min(1).max(120),
    kind: z.enum(REPORT_ROW_KINDS),
    /** ACCOUNTS / DIMENSION_GROUP: the accounts aggregated. */
    accounts: accountSelectorSchema.optional(),
    /** FORMULA: row keys combined with + and -, e.g. "REVENUE - COST_OF_SALES". */
    formula: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .regex(/^[A-Z][A-Z0-9_]*(\s*[-+]\s*[A-Z][A-Z0-9_]*)*$/, 'Formula: KEY [+|- KEY]...')
      .optional(),
    /** DIMENSION_GROUP: one sub-row per active value of this dimension type. */
    dimensionType: z.enum(DIMENSION_TYPES).optional(),
    sign: z.enum(REPORT_SIGNS).default('NATURAL'),
    /** Expand the row into one line per account beneath it. */
    showAccounts: z.boolean().default(false),
    bold: z.boolean().default(false),
    /** Rows a formula references but that should not be printed. */
    hidden: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    if ((r.kind === 'ACCOUNTS' || r.kind === 'DIMENSION_GROUP') && !r.accounts)
      ctx.addIssue({
        code: 'custom',
        message: `${r.kind} rows need an account selector`,
        path: ['accounts'],
      });
    if (r.kind === 'FORMULA' && !r.formula)
      ctx.addIssue({ code: 'custom', message: 'FORMULA rows need a formula', path: ['formula'] });
    if (r.kind === 'DIMENSION_GROUP' && !r.dimensionType)
      ctx.addIssue({
        code: 'custom',
        message: 'DIMENSION_GROUP rows need a dimension type',
        path: ['dimensionType'],
      });
  });
export type ReportRowInput = z.infer<typeof reportRowSchema>;

export const reportColumnSchema = z
  .object({
    key: rowKey,
    label: z.string().trim().min(1).max(60),
    kind: z.enum(REPORT_COLUMN_KINDS),
    /** CUSTOM_RANGE only. */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    /** VARIANCE / VARIANCE_PCT: base column (actual) and the column it is compared against. */
    base: rowKey.optional(),
    against: rowKey.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.kind === 'CUSTOM_RANGE' && !(c.from && c.to))
      ctx.addIssue({
        code: 'custom',
        message: 'CUSTOM_RANGE columns need from and to',
        path: ['from'],
      });
    if ((c.kind === 'VARIANCE' || c.kind === 'VARIANCE_PCT') && !(c.base && c.against))
      ctx.addIssue({
        code: 'custom',
        message: 'Variance columns need base and against',
        path: ['base'],
      });
  });
export type ReportColumnInput = z.infer<typeof reportColumnSchema>;

export const reportFiltersSchema = dimensionRefsSchema.extend({
  branchId: uuidSchema.nullable().optional(),
});

export const reportLayoutSchema = z
  .object({
    rows: z.array(reportRowSchema).min(1).max(200),
    columns: z.array(reportColumnSchema).min(1).max(12),
    filters: reportFiltersSchema.optional(),
  })
  .superRefine((l, ctx) => {
    const rowKeys = new Set(l.rows.map((r) => r.key));
    if (rowKeys.size !== l.rows.length)
      ctx.addIssue({ code: 'custom', message: 'Row keys must be unique', path: ['rows'] });
    const colKeys = new Set(l.columns.map((c) => c.key));
    if (colKeys.size !== l.columns.length)
      ctx.addIssue({ code: 'custom', message: 'Column keys must be unique', path: ['columns'] });
    for (const r of l.rows) {
      if (r.formula)
        for (const ref of r.formula.split(/\s*[-+]\s*/))
          if (!rowKeys.has(ref))
            ctx.addIssue({
              code: 'custom',
              message: `Formula of ${r.key} references unknown row ${ref}`,
              path: ['rows'],
            });
    }
    for (const c of l.columns) {
      if (c.base && !colKeys.has(c.base))
        ctx.addIssue({
          code: 'custom',
          message: `Column ${c.key} bases on unknown column ${c.base}`,
          path: ['columns'],
        });
      if (c.against && !colKeys.has(c.against))
        ctx.addIssue({
          code: 'custom',
          message: `Column ${c.key} compares against unknown column ${c.against}`,
          path: ['columns'],
        });
    }
  });
export type ReportLayoutInput = z.infer<typeof reportLayoutSchema>;

export const createReportDefinitionSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: optionalText(500),
  category: z.enum(REPORT_CATEGORIES).default('CUSTOM'),
  basis: z.enum(REPORT_BASES).default('PERIOD'),
  layout: reportLayoutSchema,
});
export type CreateReportDefinitionInput = z.infer<typeof createReportDefinitionSchema>;

export const updateReportDefinitionSchema = createReportDefinitionSchema
  .omit({ code: true })
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateReportDefinitionInput = z.infer<typeof updateReportDefinitionSchema>;

/** Copy a (system or custom) definition into a new editable custom report. */
export const copyReportDefinitionSchema = z.object({ code: codeSchema, name: nameSchema });
export type CopyReportDefinitionInput = z.infer<typeof copyReportDefinitionSchema>;

/** Parameters of one run: the current period and optional overrides of the saved filters. */
export const runReportSchema = reportFiltersSchema
  .extend({
    from: isoDateSchema,
    to: isoDateSchema,
    /** Budget to take BUDGET columns from; defaults to the approved budget of the period's fiscal year. */
    budgetId: uuidSchema.optional(),
    /** Include zero rows / accounts. */
    includeZero: z.boolean().default(false),
  })
  .refine((r) => r.from <= r.to, { message: '"from" must not be after "to"', path: ['to'] });
export type RunReportInput = z.infer<typeof runReportSchema>;

/** Run an unsaved layout (the editor's preview). */
export const runAdHocReportSchema = z.object({
  basis: z.enum(REPORT_BASES).default('PERIOD'),
  layout: reportLayoutSchema,
  params: runReportSchema,
});
export type RunAdHocReportInput = z.infer<typeof runAdHocReportSchema>;

export const listReportDefinitionsQuerySchema = paginationQuerySchema.extend({
  category: z.enum(REPORT_CATEGORIES).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});
export type ListReportDefinitionsQuery = z.infer<typeof listReportDefinitionsQuerySchema>;

// ----------------------------------------------------- journal control center

export const journalControlQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  branchId: uuidSchema.optional(),
});
export type JournalControlQuery = z.infer<typeof journalControlQuerySchema>;
