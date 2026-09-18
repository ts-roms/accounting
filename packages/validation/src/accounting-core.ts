import { z } from 'zod';
import {
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_TYPES,
  DIMENSION_RULE_SCOPES,
  DIMENSION_TYPES,
  ENTITY_STATUSES,
  JOURNAL_TYPES,
  POSTING_RULE_ACCOUNT_SOURCES,
  POSTING_SIDES,
  PREPAYMENT_STATUSES,
  RECURRING_FREQUENCIES,
  RECURRING_JOURNAL_MODES,
  RECURRING_JOURNAL_STATUSES,
} from '@accounting/types';
import { amountSchema, isoDateSchema, journalLineSchema } from './accounting.js';
import { dimensionRefsSchema } from './dimensions.js';
import { nameSchema, optionalText, paginationQuerySchema, uuidSchema } from './primitives.js';

/*
 * Accounting core extensions: opening balances, recurring journals, prepayments,
 * posting rules, dimension rules, cash-flow and suspense queries. Shared by the
 * API (nestjs-zod DTOs) and the web forms.
 */

// --------------------------------------------------------------- opening balances

export const openingBalanceLineSchema = dimensionRefsSchema.extend({
  accountId: uuidSchema,
  debit: amountSchema.default('0'),
  credit: amountSchema.default('0'),
  description: optionalText(300),
  branchId: uuidSchema.nullable().optional(),
});

/**
 * Opening balances are an OPENING journal. Lines that do not balance are
 * offset against the `OPENING_BALANCE_EQUITY` mapping, so the entry always
 * balances before it enters the normal submit / approve / post workflow.
 */
export const openingBalancesSchema = z.object({
  asOfDate: isoDateSchema,
  description: z.string().trim().min(1).max(500).default('Opening balances'),
  reference: optionalText(100),
  branchId: uuidSchema.nullable().optional(),
  lines: z.array(openingBalanceLineSchema).min(1).max(2000),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type OpeningBalancesInput = z.infer<typeof openingBalancesSchema>;

// ------------------------------------------------------------- recurring journals

export const recurringJournalSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().min(1, 'Description is required').max(500),
    reference: optionalText(100),
    journalType: z.enum(JOURNAL_TYPES).default('GENERAL'),
    frequency: z.enum(RECURRING_FREQUENCIES),
    /** Every N frequency units (e.g. MONTHLY x 3 = quarterly). */
    interval: z.coerce.number().int().min(1).max(36).default(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema.nullable().optional(),
    /** Stop after this many occurrences (null = until endDate / forever). */
    maxOccurrences: z.coerce.number().int().min(1).max(1000).nullable().optional(),
    mode: z.enum(RECURRING_JOURNAL_MODES).default('DRAFT'),
    /** Post a mirror REVERSAL on the first day after each occurrence's period (accruals). */
    autoReverse: z.boolean().default(false),
    branchId: uuidSchema.nullable().optional(),
    lines: z.array(journalLineSchema).min(2).max(200),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'End date must be on or after the start date',
    path: ['endDate'],
  });
export type RecurringJournalInput = z.infer<typeof recurringJournalSchema>;

export const updateRecurringJournalSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  reference: optionalText(100),
  endDate: isoDateSchema.nullable().optional(),
  maxOccurrences: z.coerce.number().int().min(1).max(1000).nullable().optional(),
  mode: z.enum(RECURRING_JOURNAL_MODES).optional(),
  autoReverse: z.boolean().optional(),
  status: z.enum(RECURRING_JOURNAL_STATUSES).optional(),
  lines: z.array(journalLineSchema).min(2).max(200).optional(),
});
export type UpdateRecurringJournalInput = z.infer<typeof updateRecurringJournalSchema>;

export const listRecurringJournalsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(RECURRING_JOURNAL_STATUSES).optional(),
});
export type ListRecurringJournalsQuery = z.infer<typeof listRecurringJournalsQuerySchema>;

/** Generate every occurrence due on or before `asOf` (defaults to today). */
export const runRecurringJournalsSchema = z.object({
  asOf: isoDateSchema.optional(),
  /** Restrict the run to one template. */
  recurringJournalId: uuidSchema.optional(),
});
export type RunRecurringJournalsInput = z.infer<typeof runRecurringJournalsSchema>;

// ------------------------------------------------------------------ prepayments

export const prepaymentSchema = z.object({
  name: nameSchema,
  description: optionalText(500),
  reference: optionalText(100),
  /** Balance-sheet account holding the prepaid amount (subtype PREPAID). */
  prepaidAccountId: uuidSchema,
  /** Expense account the prepayment is recognised into. */
  expenseAccountId: uuidSchema,
  /**
   * Credit side of the initial posting (cash / bank / payable). Omit when the
   * initial entry was already posted by another document (e.g. an AP bill
   * coded to the prepaid account); activation then only starts the schedule.
   */
  creditAccountId: uuidSchema.nullable().optional(),
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  /** Date of the initial posting and of the first recognition period. */
  startDate: isoDateSchema,
  /** Number of monthly recognitions the amount is spread over. */
  months: z.coerce.number().int().min(1).max(120),
  branchId: uuidSchema.nullable().optional(),
  departmentId: uuidSchema.nullable().optional(),
  costCenterId: uuidSchema.nullable().optional(),
  projectId: uuidSchema.nullable().optional(),
});
export type PrepaymentInput = z.infer<typeof prepaymentSchema>;

export const listPrepaymentsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PREPAYMENT_STATUSES).optional(),
});
export type ListPrepaymentsQuery = z.infer<typeof listPrepaymentsQuerySchema>;

export const recognizePrepaymentsSchema = z.object({
  asOf: isoDateSchema.optional(),
  prepaymentId: uuidSchema.optional(),
});
export type RecognizePrepaymentsInput = z.infer<typeof recognizePrepaymentsSchema>;

// ---------------------------------------------------------------- posting rules

/** Identifier of a transaction type a module posts (e.g. CUSTOMER_INVOICE). */
export const transactionTypeSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use uppercase letters, digits and "_"');

/** Key of an amount / account the calling module supplies (NET, TAX, GROSS, ...). */
export const contextKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use uppercase letters, digits and "_"');

export const postingRuleLineSchema = z
  .object({
    side: z.enum(POSTING_SIDES),
    accountSource: z.enum(POSTING_RULE_ACCOUNT_SOURCES),
    mappingKey: z.enum(ACCOUNT_MAPPING_KEYS).nullable().optional(),
    accountId: uuidSchema.nullable().optional(),
    /** For CONTEXT: the key under which the module passes the account id. */
    accountKey: contextKeySchema.nullable().optional(),
    /** Which amount of the transaction this line carries. */
    amountKey: contextKeySchema,
    description: optionalText(200),
  })
  .refine(
    (l) =>
      (l.accountSource === 'MAPPING' && !!l.mappingKey) ||
      (l.accountSource === 'ACCOUNT' && !!l.accountId) ||
      (l.accountSource === 'CONTEXT' && !!l.accountKey),
    {
      message: 'The account source needs its mapping key, account or context key',
      path: ['accountSource'],
    },
  );
export type PostingRuleLineInput = z.infer<typeof postingRuleLineSchema>;

export const postingRuleSchema = z.object({
  transactionType: transactionTypeSchema,
  name: nameSchema,
  description: optionalText(500),
  journalType: z.enum(JOURNAL_TYPES).default('GENERAL'),
  lines: z.array(postingRuleLineSchema).min(2).max(50),
  status: z.enum(ENTITY_STATUSES).default('ACTIVE'),
});
export type PostingRuleInput = z.infer<typeof postingRuleSchema>;

export const updatePostingRuleSchema = postingRuleSchema.omit({ transactionType: true }).partial();
export type UpdatePostingRuleInput = z.infer<typeof updatePostingRuleSchema>;

/** Resolve a rule against sample amounts (UI preview and module integration tests). */
export const simulatePostingRuleSchema = z.object({
  amounts: z.record(contextKeySchema, amountSchema),
  accounts: z.record(contextKeySchema, uuidSchema).default({}),
});
export type SimulatePostingRuleInput = z.infer<typeof simulatePostingRuleSchema>;

// -------------------------------------------------------------- dimension rules

export const dimensionRuleSchema = z
  .object({
    name: nameSchema,
    scope: z.enum(DIMENSION_RULE_SCOPES),
    accountId: uuidSchema.nullable().optional(),
    accountType: z.enum(ACCOUNT_TYPES).nullable().optional(),
    codePrefix: z.string().trim().min(1).max(20).nullable().optional(),
    dimensionType: z.enum(DIMENSION_TYPES),
    status: z.enum(ENTITY_STATUSES).default('ACTIVE'),
  })
  .refine(
    (r) =>
      (r.scope === 'ACCOUNT' && !!r.accountId) ||
      (r.scope === 'ACCOUNT_TYPE' && !!r.accountType) ||
      (r.scope === 'CODE_PREFIX' && !!r.codePrefix),
    { message: 'The scope needs an account, account type or code prefix', path: ['scope'] },
  );
export type DimensionRuleInput = z.infer<typeof dimensionRuleSchema>;

export const updateDimensionRuleSchema = z.object({
  name: nameSchema.optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
});
export type UpdateDimensionRuleInput = z.infer<typeof updateDimensionRuleSchema>;

// ------------------------------------------------------------ cash flow / suspense

export const cashFlowQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    branchId: uuidSchema.optional(),
  })
  .refine((r) => r.from <= r.to, { message: '"from" must not be after "to"', path: ['to'] });
export type CashFlowQuery = z.infer<typeof cashFlowQuerySchema>;

export const suspenseQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
});
export type SuspenseQuery = z.infer<typeof suspenseQuerySchema>;
