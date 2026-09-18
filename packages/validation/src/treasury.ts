import { z } from 'zod';
import {
  BANK_ACCOUNT_TYPES,
  BANK_TRANSFER_PURPOSES,
  BANK_TRANSFER_STATUSES,
  FORECAST_GRANULARITIES,
  FORECAST_ITEM_DIRECTIONS,
  FORECAST_ITEM_FREQUENCIES,
  FORECAST_SCENARIOS,
  PAYMENT_FILE_FORMATS,
  PAYMENT_FILE_STATUSES,
  PETTY_CASH_FUND_STATUSES,
  PETTY_CASH_VOUCHER_STATUSES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting.js';
import { dimensionRefsSchema } from './dimensions.js';
import { exchangeRateValueSchema } from './enterprise.js';
import {
  codeSchema,
  nameSchema,
  optionalCurrencyCodeSchema,
  optionalText,
  paginationQuerySchema,
  queryBooleanSchema,
  uuidSchema,
} from './primitives.js';
import { percentSchema } from './subledger.js';

const positiveAmount = amountSchema.refine((v) => Number(v) > 0, 'Amount must be positive');

// ------------------------------------------------------- bank account profile

/** Treasury attributes of a bank account (the account itself is managed in banking). */
export const bankAccountProfileSchema = z.object({
  accountType: z.enum(BANK_ACCOUNT_TYPES).optional(),
  purpose: optionalText(120),
  /** Alert below this balance. */
  minimumBalance: amountSchema.nullable().optional(),
  /** Sweep / funding target. */
  targetBalance: amountSchema.nullable().optional(),
  /** Committed credit line the account may draw on. */
  overdraftLimit: amountSchema.nullable().optional(),
  /** Bank routing identifier (BRSTN / SWIFT / BIC). */
  routingCode: optionalText(34),
  paymentFileFormat: z.enum(PAYMENT_FILE_FORMATS).nullable().optional(),
  /** Originator id the bank assigned for batch files. */
  originatorId: optionalText(64),
  isDefaultReceipts: z.boolean().optional(),
  isDefaultPayments: z.boolean().optional(),
  signatories: optionalText(500),
  /** Excluded from the cash position (e.g. restricted / escrow). */
  excludeFromPosition: z.boolean().optional(),
});
export type BankAccountProfileInput = z.infer<typeof bankAccountProfileSchema>;

// ------------------------------------------------------------ bank transfers

export const createBankTransferSchema = z
  .object({
    fromBankAccountId: uuidSchema,
    toBankAccountId: uuidSchema,
    transferDate: isoDateSchema,
    /** Expected settlement (defaults to the transfer date). */
    expectedSettlementDate: isoDateSchema.optional(),
    /** Amount leaving the source account, in its currency. */
    amount: positiveAmount,
    /** Amount arriving in the destination account (cross-currency); defaults to the rate-table conversion. */
    receivedAmount: positiveAmount.optional(),
    purpose: z.enum(BANK_TRANSFER_PURPOSES).default('FUNDING'),
    reference: optionalText(100),
    memo: optionalText(500),
    /** Bank charge deducted from the source account, posted to bank charges. */
    feeAmount: amountSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(100).optional(),
  })
  .refine((v) => v.fromBankAccountId !== v.toBankAccountId, {
    message: 'Source and destination must differ',
    path: ['toBankAccountId'],
  });
export type CreateBankTransferInput = z.infer<typeof createBankTransferSchema>;

export const settleBankTransferSchema = z.object({
  settlementDate: isoDateSchema.optional(),
  /** Actual amount credited by the destination bank (cross-currency); the difference posts to FX. */
  receivedAmount: positiveAmount.optional(),
  bankReference: optionalText(100),
});
export type SettleBankTransferInput = z.infer<typeof settleBankTransferSchema>;

export const listBankTransfersQuerySchema = paginationQuerySchema.extend({
  status: z.enum(BANK_TRANSFER_STATUSES).optional(),
  bankAccountId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListBankTransfersQuery = z.infer<typeof listBankTransfersQuerySchema>;

// ------------------------------------------------------------- payment files

export const createPaymentFileSchema = z
  .object({
    bankAccountId: uuidSchema,
    format: z.enum(PAYMENT_FILE_FORMATS),
    /** Take every posted, unfiled payment of an executed run ... */
    paymentRunId: uuidSchema.optional(),
    /** ... or the listed posted vendor payments from the bank account. */
    paymentIds: z.array(uuidSchema).max(500).optional(),
    /** Value date written into the file (defaults to today). */
    valueDate: isoDateSchema.optional(),
    description: optionalText(200),
  })
  .refine((v) => Boolean(v.paymentRunId) !== Boolean(v.paymentIds?.length), {
    message: 'Give either a payment run or a list of payments',
    path: ['paymentRunId'],
  });
export type CreatePaymentFileInput = z.infer<typeof createPaymentFileSchema>;

export const paymentFileStatusSchema = z.object({
  status: z.enum(['TRANSMITTED', 'ACKNOWLEDGED', 'REJECTED', 'CANCELLED']),
  bankReference: optionalText(120),
  note: optionalText(500),
});
export type PaymentFileStatusInput = z.infer<typeof paymentFileStatusSchema>;

export const listPaymentFilesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PAYMENT_FILE_STATUSES).optional(),
  bankAccountId: uuidSchema.optional(),
  format: z.enum(PAYMENT_FILE_FORMATS).optional(),
});
export type ListPaymentFilesQuery = z.infer<typeof listPaymentFilesQuerySchema>;

// ---------------------------------------------------------------- petty cash

export const createPettyCashFundSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  /** Cash-on-hand GL account dedicated to the fund. */
  glAccountId: uuidSchema,
  /** Imprest amount the fund is replenished back to. */
  imprestAmount: positiveAmount,
  custodianId: uuidSchema,
  branchId: uuidSchema.nullable().optional(),
  /** Vouchers above this need approval by someone other than the custodian. */
  voucherApprovalLimit: amountSchema.nullable().optional(),
  /** Replenish when cash on hand falls below this share of the imprest (0-100). */
  replenishAtPercent: percentSchema.optional(),
  notes: optionalText(500),
});
export type CreatePettyCashFundInput = z.infer<typeof createPettyCashFundSchema>;
export const updatePettyCashFundSchema = createPettyCashFundSchema
  .omit({ code: true, glAccountId: true })
  .partial()
  .extend({ status: z.enum(PETTY_CASH_FUND_STATUSES).optional() });
export type UpdatePettyCashFundInput = z.infer<typeof updatePettyCashFundSchema>;

export const pettyCashVoucherLineSchema = z.object({
  description: z.string().trim().min(1).max(300),
  accountId: uuidSchema,
  amount: positiveAmount,
  taxCodeId: uuidSchema.nullable().optional(),
  dimensions: dimensionRefsSchema.optional(),
});
export type PettyCashVoucherLineInput = z.infer<typeof pettyCashVoucherLineSchema>;

export const createPettyCashVoucherSchema = z.object({
  fundId: uuidSchema,
  voucherDate: isoDateSchema,
  payee: z.string().trim().min(1).max(150),
  description: optionalText(500),
  receiptReference: optionalText(100),
  lines: z.array(pettyCashVoucherLineSchema).min(1).max(50),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});
export type CreatePettyCashVoucherInput = z.infer<typeof createPettyCashVoucherSchema>;
export const updatePettyCashVoucherSchema = createPettyCashVoucherSchema
  .omit({ fundId: true, idempotencyKey: true })
  .partial();
export type UpdatePettyCashVoucherInput = z.infer<typeof updatePettyCashVoucherSchema>;

export const replenishPettyCashSchema = z.object({
  /** Bank account the cash is drawn from. */
  bankAccountId: uuidSchema,
  replenishmentDate: isoDateSchema,
  /** Defaults to imprest - cash on hand (the posted vouchers since the last replenishment). */
  amount: positiveAmount.optional(),
  reference: optionalText(100),
});
export type ReplenishPettyCashInput = z.infer<typeof replenishPettyCashSchema>;

export const listPettyCashVouchersQuerySchema = paginationQuerySchema.extend({
  fundId: uuidSchema.optional(),
  status: z.enum(PETTY_CASH_VOUCHER_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type ListPettyCashVouchersQuery = z.infer<typeof listPettyCashVouchersQuerySchema>;

// ------------------------------------------------------------------ forecast

export const createForecastItemSchema = z.object({
  name: nameSchema,
  direction: z.enum(FORECAST_ITEM_DIRECTIONS),
  amount: positiveAmount,
  currency: optionalCurrencyCodeSchema,
  frequency: z.enum(FORECAST_ITEM_FREQUENCIES).default('MONTHLY'),
  /** First (or only) occurrence. */
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable().optional(),
  /** Bank account the flow hits (null = any / unallocated). */
  bankAccountId: uuidSchema.nullable().optional(),
  category: optionalText(60),
  notes: optionalText(500),
});
export type CreateForecastItemInput = z.infer<typeof createForecastItemSchema>;
export const updateForecastItemSchema = createForecastItemSchema
  .partial()
  .extend({ active: z.boolean().optional() });
export type UpdateForecastItemInput = z.infer<typeof updateForecastItemSchema>;

export const cashForecastQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  /** Horizon in days (default from settings). */
  horizonDays: z.coerce.number().int().min(7).max(365).optional(),
  granularity: z.enum(FORECAST_GRANULARITIES).optional(),
  scenario: z.enum(FORECAST_SCENARIOS).default('BASE'),
  bankAccountId: uuidSchema.optional(),
  /** Persist the run as a snapshot for accuracy tracking. */
  save: queryBooleanSchema.optional(),
});
export type CashForecastQuery = z.infer<typeof cashForecastQuerySchema>;

export const cashPositionQuerySchema = z.object({
  asOf: isoDateSchema.optional(),
  currency: optionalCurrencyCodeSchema,
});
export type CashPositionQuery = z.infer<typeof cashPositionQuerySchema>;

// ------------------------------------------------------------------ settings

const scenarioSchema = z.object({
  inflowFactor: z.string().regex(/^\d+(\.\d+)?$/),
  outflowFactor: z.string().regex(/^\d+(\.\d+)?$/),
  inflowDelayDays: z.coerce.number().int().min(0).max(120),
});

export const treasurySettingsSchema = z.object({
  forecastHorizonDays: z.coerce.number().int().min(7).max(365).optional(),
  forecastGranularity: z.enum(FORECAST_GRANULARITIES).optional(),
  /** Collection probability per AR aging bucket key (0-1 as decimal strings). */
  collectionProbabilities: z
    .record(z.string(), z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/))
    .optional(),
  scenarios: z
    .object({ BASE: scenarioSchema, OPTIMISTIC: scenarioSchema, PESSIMISTIC: scenarioSchema })
    .partial()
    .optional(),
  /** Days of average outflow the company wants covered by cash. */
  minimumDaysCashOnHand: z.coerce.number().int().min(0).max(365).optional(),
  /** Window used to compute average daily outflow. */
  burnWindowDays: z.coerce.number().int().min(30).max(365).optional(),
  /** Transfers above this need approval by someone else (null = always). */
  transferApprovalThreshold: amountSchema.nullable().optional(),
  /** Alert when a SENT transfer is unsettled this many days past expected settlement. */
  unsettledTransferWarnDays: z.coerce.number().int().min(0).max(60).optional(),
  /** Default bank payment file format. */
  defaultPaymentFileFormat: z.enum(PAYMENT_FILE_FORMATS).optional(),
  /** Company-level originator name for payment files. */
  originatorName: optionalText(120),
  /** Petty cash vouchers above this amount always need approval. */
  pettyCashVoucherLimit: amountSchema.nullable().optional(),
});
export type TreasurySettingsInput = z.infer<typeof treasurySettingsSchema>;

/** Exchange rate override on cross-currency transfers. */
export const transferRateSchema = exchangeRateValueSchema;
