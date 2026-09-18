import { z } from 'zod';
import {
  BANK_FEED_ACTIONS,
  BANK_RULE_DIRECTIONS,
  BANK_RULE_MATCH_MODES,
  BANK_RULE_STATUSES,
  BANK_SUGGESTION_STATUSES,
  BANK_TRANSACTION_TYPES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting.js';
import { dimensionRefsSchema } from './dimensions.js';
import { nameSchema, optionalText, paginationQuerySchema, uuidSchema } from './primitives.js';

const patternSchema = z.string().trim().min(1).max(200);

/** The instruction behind a rule or a manual explanation; the action decides which fields matter. */
const feedActionFields = dimensionRefsSchema.extend({
  action: z.enum(BANK_FEED_ACTIONS),
  /** POST_TRANSACTION: DEPOSIT / INTEREST for money in, WITHDRAWAL / BANK_FEE for money out. */
  transactionType: z.enum(BANK_TRANSACTION_TYPES).optional(),
  counterpartyAccountId: uuidSchema.nullable().optional(),
  memo: optionalText(300),
  /** RECEIVE_CUSTOMER: the customer; PAY_VENDOR: the vendor. */
  partyId: uuidSchema.nullable().optional(),
});

function validateAction(
  a: z.infer<typeof feedActionFields>,
  ctx: z.RefinementCtx,
  requireAccount: boolean,
) {
  if (a.action === 'POST_TRANSACTION') {
    if (!a.transactionType || a.transactionType === 'TRANSFER')
      ctx.addIssue({
        code: 'custom',
        path: ['transactionType'],
        message: 'Choose a deposit, withdrawal, fee or interest type',
      });
    if (requireAccount && !a.counterpartyAccountId)
      ctx.addIssue({
        code: 'custom',
        path: ['counterpartyAccountId'],
        message: 'Choose the counterparty account',
      });
  }
  if (
    (a.action === 'RECEIVE_CUSTOMER' || a.action === 'PAY_VENDOR') &&
    requireAccount &&
    !a.partyId
  )
    ctx.addIssue({ code: 'custom', path: ['partyId'], message: 'Choose the customer / vendor' });
}

// -------------------------------------------------------------------- rules

const ruleFields = feedActionFields.extend({
  name: nameSchema,
  description: optionalText(500),
  /** Lower runs first. */
  priority: z.coerce.number().int().min(1).max(999).default(100),
  /** Blank = every bank account of the company. */
  bankAccountId: uuidSchema.nullable().optional(),
  direction: z.enum(BANK_RULE_DIRECTIONS).default('ANY'),
  descriptionPattern: patternSchema.nullable().optional(),
  descriptionMode: z.enum(BANK_RULE_MATCH_MODES).default('CONTAINS'),
  referencePattern: patternSchema.nullable().optional(),
  referenceMode: z.enum(BANK_RULE_MATCH_MODES).default('CONTAINS'),
  /** Absolute amount bounds (inclusive); blank = any. */
  amountMin: amountSchema.nullable().optional(),
  amountMax: amountSchema.nullable().optional(),
  /** Apply without a person confirming (the ledger entry posts as the rule says). */
  autoApply: z.boolean().default(false),
});

export const createBankMatchingRuleSchema = ruleFields.superRefine((r, ctx) => {
  validateAction(r, ctx, true);
  if (!r.descriptionPattern && !r.referencePattern && r.amountMin == null && r.amountMax == null)
    ctx.addIssue({
      code: 'custom',
      path: ['descriptionPattern'],
      message: 'A rule needs a text pattern or an amount range',
    });
  if (r.amountMin != null && r.amountMax != null && Number(r.amountMax) < Number(r.amountMin))
    ctx.addIssue({ code: 'custom', path: ['amountMax'], message: 'Maximum is below minimum' });
  for (const [pattern, mode, path] of [
    [r.descriptionPattern, r.descriptionMode, 'descriptionPattern'],
    [r.referencePattern, r.referenceMode, 'referencePattern'],
  ] as const) {
    if (pattern && mode === 'REGEX') {
      try {
        new RegExp(pattern, 'i');
      } catch {
        ctx.addIssue({ code: 'custom', path: [path], message: 'Invalid regular expression' });
      }
    }
  }
});
export type CreateBankMatchingRuleInput = z.infer<typeof createBankMatchingRuleSchema>;

export const updateBankMatchingRuleSchema = ruleFields.partial().extend({
  status: z.enum(BANK_RULE_STATUSES).optional(),
});
export type UpdateBankMatchingRuleInput = z.infer<typeof updateBankMatchingRuleSchema>;

export const testBankMatchingRuleSchema = ruleFields.partial().extend({
  direction: z.enum(BANK_RULE_DIRECTIONS).default('ANY'),
  descriptionMode: z.enum(BANK_RULE_MATCH_MODES).default('CONTAINS'),
  referenceMode: z.enum(BANK_RULE_MATCH_MODES).default('CONTAINS'),
});
export type TestBankMatchingRuleInput = z.infer<typeof testBankMatchingRuleSchema>;

// ----------------------------------------------------------------- settings

export const updateBankFeedSettingsSchema = z.object({
  /** Rules flagged autoApply post without review. */
  autoApplyRules: z.boolean().optional(),
  /** HIGH-confidence document matches (invoice / bill number in the text) post without review. */
  autoApplyDocumentMatches: z.boolean().optional(),
  /** Lines unexplained for longer than this are flagged stale. */
  staleAfterDays: z.coerce.number().int().min(1).max(365).optional(),
  /** How many past explanations a description needs before HISTORY suggests it with MEDIUM confidence. */
  historyMinOccurrences: z.coerce.number().int().min(1).max(20).optional(),
});
export type UpdateBankFeedSettingsInput = z.infer<typeof updateBankFeedSettingsSchema>;

// -------------------------------------------------------------- suggestions

export const bankFeedQueueQuerySchema = paginationQuerySchema.extend({
  bankAccountId: uuidSchema.optional(),
  /** Only lines with a pending suggestion / without one. */
  suggested: z.enum(['YES', 'NO']).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type BankFeedQueueQuery = z.infer<typeof bankFeedQueueQuerySchema>;

export const listBankSuggestionsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(BANK_SUGGESTION_STATUSES).optional(),
});
export type ListBankSuggestionsQuery = z.infer<typeof listBankSuggestionsQuerySchema>;

export const suggestBankFeedSchema = z.object({
  statementId: uuidSchema.optional(),
  bankAccountId: uuidSchema.optional(),
});
export type SuggestBankFeedInput = z.infer<typeof suggestBankFeedSchema>;

/** Apply a suggestion, optionally overriding what it proposes. */
export const applyBankSuggestionSchema = feedActionFields.partial({ action: true }).extend({
  allocations: z
    .array(z.object({ documentId: uuidSchema, amount: amountSchema.refine((v) => Number(v) > 0) }))
    .max(100)
    .optional(),
});
export type ApplyBankSuggestionInput = z.infer<typeof applyBankSuggestionSchema>;

/** Explain a line by hand (no suggestion): the same instruction shape, fully specified. */
export const explainBankLineSchema = feedActionFields
  .extend({
    allocations: z
      .array(
        z.object({ documentId: uuidSchema, amount: amountSchema.refine((v) => Number(v) > 0) }),
      )
      .max(100)
      .optional(),
    note: optionalText(300),
  })
  .superRefine((a, ctx) => validateAction(a, ctx, true));
export type ExplainBankLineInput = z.infer<typeof explainBankLineSchema>;

export const bankFeedDashboardQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  days: z.coerce.number().int().min(7).max(365).default(30),
});
export type BankFeedDashboardQuery = z.infer<typeof bankFeedDashboardQuerySchema>;
