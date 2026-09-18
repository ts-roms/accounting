import { z } from 'zod';
import {
  ASSET_STATUSES,
  BANK_TRANSACTION_STATUSES,
  BANK_TRANSACTION_TYPES,
  DEPRECIATION_METHODS,
  DEPRECIATION_RUN_STATUSES,
  ENTITY_STATUSES,
  STATEMENT_LINE_STATUSES,
  MATCH_CONFIDENCES,
} from '@accounting/types';
import { amountSchema, isoDateSchema, signedAmountSchema } from './accounting';
import { exchangeRateValueSchema } from './enterprise';
import {
  codeSchema,
  nameSchema,
  optionalText,
  paginationQuerySchema,
  uuidSchema,
} from './primitives';
import { percentSchema } from './subledger';

// -------------------------------------------------------------- fixed assets

export const createAssetCategorySchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: optionalText(500),
  usefulLifeMonths: z.coerce.number().int().min(1).max(1200).default(60),
  depreciationMethod: z.enum(DEPRECIATION_METHODS).default('STRAIGHT_LINE'),
  /** Annual rate for declining balance (e.g. "20" = 20% per year). */
  decliningRatePercent: percentSchema.nullable().optional(),
  assetAccountId: uuidSchema.nullable().optional(),
  accumulatedDepreciationAccountId: uuidSchema.nullable().optional(),
  depreciationExpenseAccountId: uuidSchema.nullable().optional(),
});
export type CreateAssetCategoryInput = z.infer<typeof createAssetCategorySchema>;
export const updateAssetCategorySchema = createAssetCategorySchema
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateAssetCategoryInput = z.infer<typeof updateAssetCategorySchema>;

export const createAssetSchema = z.object({
  name: nameSchema,
  description: optionalText(1000),
  categoryId: uuidSchema,
  acquisitionDate: isoDateSchema,
  acquisitionCost: amountSchema.refine((v) => Number(v) > 0, 'Cost must be positive'),
  salvageValue: amountSchema.default('0'),
  /** Defaults from the category. */
  usefulLifeMonths: z.coerce.number().int().min(1).max(1200).optional(),
  depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
  decliningRatePercent: percentSchema.nullable().optional(),
  /** Depreciation starts in the period containing this date (defaults to the acquisition date). */
  inServiceDate: isoDateSchema.optional(),
  location: optionalText(200),
  branchId: uuidSchema.nullable().optional(),
  serialNumber: optionalText(100),
  vendorId: uuidSchema.nullable().optional(),
  reference: optionalText(100),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export const updateAssetSchema = createAssetSchema.omit({ idempotencyKey: true }).partial();
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

export const listAssetsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(ASSET_STATUSES).optional(),
  categoryId: uuidSchema.optional(),
});
export type ListAssetsQuery = z.infer<typeof listAssetsQuerySchema>;

/** Capitalise: Dr asset cost account / Cr the account the asset was paid from or accrued to. */
export const capitalizeAssetSchema = z.object({
  /** Defaults to the FIXED_ASSET_CLEARING mapping. */
  creditAccountId: uuidSchema.optional(),
  postingDate: isoDateSchema.optional(),
});
export type CapitalizeAssetInput = z.infer<typeof capitalizeAssetSchema>;

export const transferAssetSchema = z.object({
  location: optionalText(200),
  branchId: uuidSchema.nullable().optional(),
  notes: optionalText(500),
  eventDate: isoDateSchema,
});
export type TransferAssetInput = z.infer<typeof transferAssetSchema>;

export const impairAssetSchema = z.object({
  eventDate: isoDateSchema,
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  notes: optionalText(500),
});
export type ImpairAssetInput = z.infer<typeof impairAssetSchema>;

export const revalueAssetSchema = z.object({
  eventDate: isoDateSchema,
  /** New carrying amount (must exceed the current book value). */
  newBookValue: amountSchema,
  notes: optionalText(500),
});
export type RevalueAssetInput = z.infer<typeof revalueAssetSchema>;

export const disposeAssetSchema = z.object({
  eventDate: isoDateSchema,
  proceeds: amountSchema.default('0'),
  /** Cash / bank / receivable account receiving the proceeds; required when proceeds > 0. */
  proceedsAccountId: uuidSchema.optional(),
  notes: optionalText(500),
});
export type DisposeAssetInput = z.infer<typeof disposeAssetSchema>;

/**
 * Split (Prompt #13): carve the asset into child assets. Each part takes a
 * share of cost and accumulated depreciation; the parent keeps the rest (or
 * is fully split when the parts add up to 100%). Register only - the
 * accounts are unchanged, so nothing posts.
 */
export const splitAssetSchema = z.object({
  eventDate: isoDateSchema,
  parts: z
    .array(
      z.object({
        name: nameSchema,
        /** Share of the parent's cost, in percent (all parts together at most 100). */
        percent: percentSchema.refine((v) => Number(v) > 0, 'Percent must be positive'),
        location: optionalText(200),
        serialNumber: optionalText(100),
      }),
    )
    .min(1)
    .max(20),
  notes: optionalText(500),
});
export type SplitAssetInput = z.infer<typeof splitAssetSchema>;

/** Register rollforward (Prompt #13): opening -> additions, depreciation, impairments, revaluations, disposals -> closing per category. */
export const assetRollforwardQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  categoryId: uuidSchema.optional(),
});
export type AssetRollforwardQuery = z.infer<typeof assetRollforwardQuerySchema>;

export const createDepreciationRunSchema = z.object({
  fiscalPeriodId: uuidSchema,
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateDepreciationRunInput = z.infer<typeof createDepreciationRunSchema>;

export const listDepreciationRunsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(DEPRECIATION_RUN_STATUSES).optional(),
});
export type ListDepreciationRunsQuery = z.infer<typeof listDepreciationRunsQuerySchema>;

export const fixedAssetSettingsSchema = z.object({
  /** When true the scheduled job posts the previous period's run automatically; otherwise it drafts it for review. */
  autoPostDepreciation: z.boolean().default(false),
});
export type FixedAssetSettingsInput = z.infer<typeof fixedAssetSettingsSchema>;

// ------------------------------------------------------------------ banking

export const createBankAccountSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  bankName: optionalText(120),
  accountNumber: optionalText(60),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** Cash / bank GL account this bank account books to (one bank account per GL account). */
  glAccountId: uuidSchema,
  branchId: uuidSchema.nullable().optional(),
  notes: optionalText(500),
});
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export const updateBankAccountSchema = createBankAccountSchema
  .omit({ glAccountId: true })
  .partial()
  .extend({ status: z.enum(ENTITY_STATUSES).optional() });
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;

export const createBankTransactionSchema = z.object({
  bankAccountId: uuidSchema,
  transactionType: z.enum(BANK_TRANSACTION_TYPES),
  transactionDate: isoDateSchema,
  amount: amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive'),
  /** Foreign-currency bank accounts: rate override (1 unit = rate base units); the rate table otherwise. */
  exchangeRate: exchangeRateValueSchema.optional(),
  /** Other side of the entry (expense, income, clearing...). Not used for transfers. */
  counterpartyAccountId: uuidSchema.optional(),
  /** Transfers: destination bank account. */
  toBankAccountId: uuidSchema.optional(),
  reference: optionalText(100),
  memo: optionalText(500),
  /** Statement line this transaction records (fee, interest...). Matched on posting. */
  statementLineId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreateBankTransactionInput = z.infer<typeof createBankTransactionSchema>;
export const updateBankTransactionSchema = createBankTransactionSchema
  .omit({ idempotencyKey: true, statementLineId: true })
  .partial();
export type UpdateBankTransactionInput = z.infer<typeof updateBankTransactionSchema>;

export const listBankTransactionsQuerySchema = paginationQuerySchema.extend({
  bankAccountId: uuidSchema.optional(),
  status: z.enum(BANK_TRANSACTION_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListBankTransactionsQuery = z.infer<typeof listBankTransactionsQuerySchema>;

export const statementLineInputSchema = z.object({
  lineDate: isoDateSchema,
  description: z.string().trim().min(1).max(300),
  reference: optionalText(100),
  /** Positive = money in, negative = money out. */
  amount: signedAmountSchema.refine((v) => Number(v) !== 0, 'Amount cannot be zero'),
  /** Running balance on the statement, when the bank provides it. */
  balance: signedAmountSchema.optional(),
});
export type StatementLineInput = z.infer<typeof statementLineInputSchema>;

export const importStatementSchema = z.object({
  bankAccountId: uuidSchema,
  statementDate: isoDateSchema,
  openingBalance: signedAmountSchema,
  closingBalance: signedAmountSchema,
  fileName: optionalText(200),
  lines: z.array(statementLineInputSchema).min(1, 'A statement needs at least one line').max(5000),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type ImportStatementInput = z.infer<typeof importStatementSchema>;

export const listStatementsQuerySchema = paginationQuerySchema.extend({
  bankAccountId: uuidSchema.optional(),
});
export type ListStatementsQuery = z.infer<typeof listStatementsQuerySchema>;

export const listStatementLinesQuerySchema = z.object({
  status: z.enum(STATEMENT_LINE_STATUSES).optional(),
});
export type ListStatementLinesQuery = z.infer<typeof listStatementLinesQuerySchema>;

/** Manual match of a statement line to a ledger line on the bank's GL account. */
export const matchStatementLineSchema = z.object({
  journalLineId: uuidSchema,
});
export type MatchStatementLineInput = z.infer<typeof matchStatementLineSchema>;

export const bankingSettingsSchema = z.object({
  /** Days either side of the statement date a ledger line may fall to auto-match. */
  matchDateToleranceDays: z.coerce.number().int().min(0).max(60).default(3),
  /**
   * Control rule: HIGH auto-matches only when amount, date window and a
   * reference agree; MEDIUM also accepts a unique amount / date hit. Anything
   * below the bar becomes POSSIBLE_MATCH for a person to confirm.
   */
  autoMatchMinConfidence: z.enum(MATCH_CONFIDENCES).default('MEDIUM'),
});
export type BankingSettingsInput = z.infer<typeof bankingSettingsSchema>;
