import { z } from 'zod';
import { dimensionRefsSchema } from './dimensions.js';
import {
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  CASH_FLOW_ACTIVITIES,
  ENTITY_STATUSES,
  JOURNAL_STATUSES,
  JOURNAL_TYPES,
  NORMAL_BALANCES,
} from '@accounting/types';
import {
  currencyCodeSchema,
  nameSchema,
  optionalCurrencyCodeSchema,
  optionalText,
  paginationQuerySchema,
  queryBooleanSchema,
  uuidSchema,
} from './primitives.js';

/** Non-negative decimal string with up to 4 fractional digits ("1250.5", "0.0000"). */
export const amountSchema = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, 'Amount must be a decimal with at most 4 fractional digits');

/** Decimal string allowing a sign (for balances / adjustments). */
export const signedAmountSchema = z
  .string()
  .trim()
  .regex(
    /^-?\d{1,15}(\.\d{1,4})?$/,
    'Amount must be a signed decimal with at most 4 fractional digits',
  );

/** ISO calendar date (YYYY-MM-DD). Business dates are explicit dates, not timestamps. */
export const isoDateSchema = z.iso.date({ message: 'Date must be YYYY-MM-DD' });

// ------------------------------------------------------------------ accounts

export const accountCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[0-9A-Z][0-9A-Z.-]*$/, 'Use digits, uppercase letters, "." or "-"');

export const createAccountSchema = z.object({
  code: accountCodeSchema,
  name: nameSchema,
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.enum(ACCOUNT_SUBTYPES).nullable().optional(),
  /** Defaults to the natural side of the type when omitted. */
  normalBalance: z.enum(NORMAL_BALANCES).optional(),
  parentId: uuidSchema.nullable().optional(),
  currency: currencyCodeSchema.nullable().optional(),
  isHeader: z.boolean().default(false),
  /** Balances are reconciled against an external source (bank, subledger, tax authority). */
  isReconciliation: z.boolean().default(false),
  /** Cash-flow statement classification; NULL derives it from the subtype. */
  cashFlowActivity: z.enum(CASH_FLOW_ACTIVITIES).nullable().optional(),
  /** Person / team accountable for clearing the balance (suspense & reconciliation accounts). */
  ownerUserId: uuidSchema.nullable().optional(),
  /** Restrict postings to these branches (empty = every branch). */
  allowedBranchIds: z.array(uuidSchema).max(200).optional(),
  description: optionalText(500),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  name: nameSchema.optional(),
  subtype: z.enum(ACCOUNT_SUBTYPES).nullable().optional(),
  parentId: uuidSchema.nullable().optional(),
  description: optionalText(500),
  status: z.enum(ENTITY_STATUSES).optional(),
  isReconciliation: z.boolean().optional(),
  cashFlowActivity: z.enum(CASH_FLOW_ACTIVITIES).nullable().optional(),
  ownerUserId: uuidSchema.nullable().optional(),
  allowedBranchIds: z.array(uuidSchema).max(200).optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const listAccountsQuerySchema = z.object({
  type: z.enum(ACCOUNT_TYPES).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  postableOnly: queryBooleanSchema.optional(),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

export const setAccountMappingSchema = z.object({
  key: z.enum(ACCOUNT_MAPPING_KEYS),
  accountId: uuidSchema.nullable(),
});
export type SetAccountMappingInput = z.infer<typeof setAccountMappingSchema>;

// ------------------------------------------------------------ fiscal periods

export const createFiscalYearSchema = z.object({
  /** First day of the fiscal year. Defaults to the company's fiscal start month of the given year. */
  startDate: isoDateSchema,
  name: z.string().trim().min(1).max(32).optional(),
});
export type CreateFiscalYearInput = z.infer<typeof createFiscalYearSchema>;

export const periodActionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
/** Reopening a closed period is never silent: a reason is mandatory. */
export const periodReopenSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason for reopening (at least 5 characters)').max(500),
});
export type PeriodReopenInput = z.infer<typeof periodReopenSchema>;
export type PeriodActionInput = z.infer<typeof periodActionSchema>;

// ----------------------------------------------------------------- journals

export const journalLineSchema = dimensionRefsSchema
  .extend({
    accountId: uuidSchema,
    description: optionalText(300),
    debit: amountSchema.default('0'),
    credit: amountSchema.default('0'),
    branchId: uuidSchema.nullable().optional(),
  })
  .refine((l) => !(l.debit !== '0' && Number(l.debit) > 0 && Number(l.credit) > 0), {
    message: 'A line carries either a debit or a credit, not both',
    path: ['credit'],
  })
  .refine((l) => Number(l.debit) > 0 || Number(l.credit) > 0, {
    message: 'A line must have a debit or a credit amount',
    path: ['debit'],
  });
export type JournalLineInput = z.infer<typeof journalLineSchema>;

/** Rate applied to a foreign-currency journal: 1 unit of the transaction currency = rate base units. */
export const journalExchangeRateSchema = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,8})?$/, 'Rate must be a positive decimal with up to 8 places')
  .refine((v) => Number(v) > 0, 'Rate must be positive');

export const journalEntryHeaderSchema = z.object({
  entryDate: isoDateSchema,
  /** Date on the underlying document when it differs from the accounting date. */
  documentDate: isoDateSchema.nullable().optional(),
  description: z.string().trim().min(1, 'Description is required').max(500),
  reference: optionalText(100),
  journalType: z.enum(JOURNAL_TYPES).default('GENERAL'),
  branchId: uuidSchema.nullable().optional(),
  /**
   * Currency the lines are entered in. Omitted = the company base currency.
   * For a foreign currency the engine converts every line to base with
   * `exchangeRate` (or the rate table) and keeps the foreign amounts on the line.
   */
  transactionCurrency: optionalCurrencyCodeSchema,
  exchangeRate: journalExchangeRateSchema.optional(),
  /** Accruals: post a mirror REVERSAL on this date (must be after the entry date). */
  autoReverseDate: isoDateSchema.nullable().optional(),
  lines: z.array(journalLineSchema).min(2, 'At least two lines are required').max(500),
  /** Client-supplied key making the create call idempotent. */
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

const autoReverseAfterEntry = (v: { entryDate?: string; autoReverseDate?: string | null }) =>
  !v.autoReverseDate || !v.entryDate || v.autoReverseDate > v.entryDate;

export const createJournalEntrySchema = journalEntryHeaderSchema.refine(autoReverseAfterEntry, {
  message: 'The auto-reverse date must be after the entry date',
  path: ['autoReverseDate'],
});
export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;

export const updateJournalEntrySchema = journalEntryHeaderSchema
  .omit({ idempotencyKey: true })
  .partial()
  .refine(autoReverseAfterEntry, {
    message: 'The auto-reverse date must be after the entry date',
    path: ['autoReverseDate'],
  });
export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntrySchema>;

export const rejectJournalEntrySchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type RejectJournalEntryInput = z.infer<typeof rejectJournalEntrySchema>;

export const reverseJournalEntrySchema = z.object({
  reversalDate: isoDateSchema,
  description: optionalText(500),
});
export type ReverseJournalEntryInput = z.infer<typeof reverseJournalEntrySchema>;

/**
 * Correction = reversal of the posted original plus a new DRAFT entry
 * pre-filled with the original lines, linked as its correction.
 */
export const correctJournalEntrySchema = z.object({
  reversalDate: isoDateSchema,
  /** Entry date of the correcting draft; defaults to the reversal date. */
  correctionDate: isoDateSchema.optional(),
  reason: z.string().trim().min(5, 'Give a reason for the correction').max(500),
});
export type CorrectJournalEntryInput = z.infer<typeof correctJournalEntrySchema>;

export const listJournalEntriesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(JOURNAL_STATUSES).optional(),
  journalType: z.enum(JOURNAL_TYPES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  fiscalPeriodId: uuidSchema.optional(),
  accountId: uuidSchema.optional(),
  // Journal control center filters (H7).
  branchId: uuidSchema.optional(),
  /** Source module (`sourceType`); `MANUAL` selects entries without a source. */
  sourceType: z.string().trim().min(1).max(60).optional(),
  createdBy: uuidSchema.optional(),
  approvedBy: uuidSchema.optional(),
  postedBy: uuidSchema.optional(),
  minAmount: amountSchema.optional(),
  maxAmount: amountSchema.optional(),
});
export type ListJournalEntriesQuery = z.infer<typeof listJournalEntriesQuerySchema>;

// ------------------------------------------------------------------ reports

export const dateRangeSchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
  })
  .refine((r) => r.from <= r.to, { message: '"from" must not be after "to"', path: ['to'] });

export const generalLedgerQuerySchema = dimensionRefsSchema.extend({
  accountId: uuidSchema,
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: uuidSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});
export type GeneralLedgerQuery = z.infer<typeof generalLedgerQuerySchema>;

export const trialBalanceQuerySchema = dimensionRefsSchema.extend({
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: uuidSchema.optional(),
  includeZero: queryBooleanSchema.default(false),
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export const incomeStatementQuerySchema = dimensionRefsSchema.extend({
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: uuidSchema.optional(),
  /** Optional comparative window (e.g. the same period last year). */
  compareFrom: isoDateSchema.optional(),
  compareTo: isoDateSchema.optional(),
});
export type IncomeStatementQuery = z.infer<typeof incomeStatementQuerySchema>;

/** Monthly income statement totals ending in the month of `to` (one read for a trend chart). */
export const incomeStatementTrendQuerySchema = z.object({
  to: isoDateSchema,
  months: z.coerce.number().int().min(1).max(36).default(6),
  branchId: uuidSchema.optional(),
});
export type IncomeStatementTrendQuery = z.infer<typeof incomeStatementTrendQuerySchema>;

export const balanceSheetQuerySchema = z.object({
  asOf: isoDateSchema,
  branchId: uuidSchema.optional(),
});
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;
