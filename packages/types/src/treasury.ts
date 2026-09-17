/**
 * Cash management & treasury (Prompt #8). Enumerations here are mirrored as
 * PostgreSQL enums; bank account / statement basics live in
 * `assets-banking.ts`.
 */

// -------------------------------------------------------------- bank accounts

export const BANK_ACCOUNT_TYPES = [
  'CURRENT',
  'SAVINGS',
  'TIME_DEPOSIT',
  'CREDIT_LINE',
  'PAYROLL',
  'TRUST',
] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/** Bank payment file formats the treasury can produce. */
export const PAYMENT_FILE_FORMATS = [
  'PESONET_CSV',
  'ISO20022_PAIN001',
  'POSITIVE_PAY_CSV',
] as const;
export type PaymentFileFormat = (typeof PAYMENT_FILE_FORMATS)[number];

export const PAYMENT_FILE_STATUSES = [
  'GENERATED',
  'TRANSMITTED',
  'ACKNOWLEDGED',
  'REJECTED',
  'CANCELLED',
] as const;
export type PaymentFileStatus = (typeof PAYMENT_FILE_STATUSES)[number];

// ------------------------------------------------------------ bank transfers

/**
 * Two-leg transfer: SENT posts Dr cash in transit / Cr source bank;
 * SETTLED posts Dr destination bank / Cr cash in transit (+ FX difference).
 */
export const BANK_TRANSFER_STATUSES = [
  'DRAFT',
  'APPROVED',
  'SENT',
  'SETTLED',
  'CANCELLED',
] as const;
export type BankTransferStatus = (typeof BANK_TRANSFER_STATUSES)[number];

export const BANK_TRANSFER_PURPOSES = [
  'FUNDING',
  'SWEEP',
  'PAYROLL',
  'FX',
  'INVESTMENT',
  'OTHER',
] as const;
export type BankTransferPurpose = (typeof BANK_TRANSFER_PURPOSES)[number];

// -------------------------------------------------------------- petty cash

export const PETTY_CASH_FUND_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type PettyCashFundStatus = (typeof PETTY_CASH_FUND_STATUSES)[number];

export const PETTY_CASH_VOUCHER_STATUSES = ['DRAFT', 'APPROVED', 'POSTED', 'VOID'] as const;
export type PettyCashVoucherStatus = (typeof PETTY_CASH_VOUCHER_STATUSES)[number];

// ---------------------------------------------------------------- forecast

/** Granularity of the rolling cash forecast. */
export const FORECAST_GRANULARITIES = ['DAY', 'WEEK', 'MONTH'] as const;
export type ForecastGranularity = (typeof FORECAST_GRANULARITIES)[number];

export const FORECAST_SCENARIOS = ['BASE', 'OPTIMISTIC', 'PESSIMISTIC'] as const;
export type ForecastScenario = (typeof FORECAST_SCENARIOS)[number];

/** Where a forecast line comes from. */
export const FORECAST_SOURCES = [
  /** Open customer invoices by due date, weighted by collection probability. */
  'AR_INVOICES',
  /** Promises to pay from collections. */
  'AR_PROMISES',
  /** Open vendor bills by due date (or discount date when a discount is open). */
  'AP_BILLS',
  /** Approved / submitted payment runs on their payment date. */
  'AP_PAYMENT_RUNS',
  /** Calculated / approved / posted-unpaid pay runs on their pay date (Prompt #11). */
  'PAYROLL',
  /** Planned items (rent, loans, taxes) maintained by treasury. */
  'PLANNED',
  /** Recurring journals with a cash account line. */
  'RECURRING',
  /** Approved transfers not yet settled. */
  'TRANSFERS',
] as const;
export type ForecastSource = (typeof FORECAST_SOURCES)[number];

export const FORECAST_ITEM_FREQUENCIES = [
  'ONCE',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'ANNUAL',
] as const;
export type ForecastItemFrequency = (typeof FORECAST_ITEM_FREQUENCIES)[number];

export const FORECAST_ITEM_DIRECTIONS = ['INFLOW', 'OUTFLOW'] as const;
export type ForecastItemDirection = (typeof FORECAST_ITEM_DIRECTIONS)[number];

/** Collection probability (0-1) per AR aging bucket key, used to weight AR inflows. */
export type CollectionProbabilities = Record<string, string>;

/** Scenario multipliers applied to inflows / outflows. */
export interface ScenarioAdjustments {
  inflowFactor: string;
  outflowFactor: string;
  /** Days added to expected inflows (customers paying late). */
  inflowDelayDays: number;
}

export const DEFAULT_COLLECTION_PROBABILITIES: CollectionProbabilities = {
  current: '0.95',
  days1to30: '0.85',
  days31to60: '0.65',
  days61to90: '0.45',
  days91to120: '0.25',
  over120: '0.10',
};

export const DEFAULT_SCENARIOS: Record<ForecastScenario, ScenarioAdjustments> = {
  BASE: { inflowFactor: '1', outflowFactor: '1', inflowDelayDays: 0 },
  OPTIMISTIC: { inflowFactor: '1.1', outflowFactor: '0.95', inflowDelayDays: 0 },
  PESSIMISTIC: { inflowFactor: '0.8', outflowFactor: '1.05', inflowDelayDays: 14 },
};
