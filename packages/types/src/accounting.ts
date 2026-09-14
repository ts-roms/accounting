/** Shared accounting enumerations (mirrored as PostgreSQL enums). */

export const ACCOUNT_TYPES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'COST_OF_SALES',
  'EXPENSE',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ['DEBIT', 'CREDIT'] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/** Natural balance side of each account type. */
export const NORMAL_BALANCE_BY_TYPE: Record<AccountType, NormalBalance> = {
  ASSET: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
  COST_OF_SALES: 'DEBIT',
  EXPENSE: 'DEBIT',
};

export const BALANCE_SHEET_TYPES: readonly AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY'];
export const INCOME_STATEMENT_TYPES: readonly AccountType[] = [
  'REVENUE',
  'COST_OF_SALES',
  'EXPENSE',
];

/**
 * Optional classification used by reports and future control-account logic
 * (AR/AP/inventory reconciliation, cash-flow statement).
 */
export const ACCOUNT_SUBTYPES = [
  'CASH',
  'BANK',
  'ACCOUNTS_RECEIVABLE',
  'INVENTORY',
  'PREPAID',
  'FIXED_ASSET',
  'ACCUMULATED_DEPRECIATION',
  'OTHER_ASSET',
  'ACCOUNTS_PAYABLE',
  'TAX_PAYABLE',
  'ACCRUED_LIABILITY',
  'LOAN',
  'OTHER_LIABILITY',
  'SHARE_CAPITAL',
  'RETAINED_EARNINGS',
  'OTHER_EQUITY',
  'SALES',
  'OTHER_INCOME',
  'COST_OF_GOODS_SOLD',
  'OPERATING_EXPENSE',
  'DEPRECIATION_EXPENSE',
  'TAX_EXPENSE',
  'OTHER_EXPENSE',
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const JOURNAL_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'POSTED',
  'LOCKED',
  'REJECTED',
  'REVERSED',
] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

/** Statuses whose lines are part of the general ledger. */
export const LEDGER_STATUSES: readonly JournalStatus[] = ['POSTED', 'LOCKED', 'REVERSED'];

export const JOURNAL_TYPES = ['GENERAL', 'ADJUSTING', 'REVERSAL', 'CLOSING', 'OPENING'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

/**
 * OPEN: normal posting. SOFT_CLOSED: only holders of `period.post-soft-closed`
 * may post (late adjustments). CLOSED: no posting; reopening needs a reason and
 * `period.reopen`. LOCKED: final - cannot be reopened or posted to by anyone.
 */
export const FISCAL_PERIOD_STATUSES = ['OPEN', 'SOFT_CLOSED', 'CLOSED', 'LOCKED'] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

export const FISCAL_YEAR_STATUSES = ['OPEN', 'CLOSED'] as const;
export type FiscalYearStatus = (typeof FISCAL_YEAR_STATUSES)[number];

/**
 * Keys of the configurable account-mapping layer. Business modules resolve
 * accounts through these keys instead of hard-coding ids.
 */
export const ACCOUNT_MAPPING_KEYS = [
  'RETAINED_EARNINGS',
  'CURRENT_YEAR_EARNINGS',
  'ROUNDING_DIFFERENCE',
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'INVENTORY',
  'COST_OF_GOODS_SOLD',
  'INVENTORY_ADJUSTMENT',
  'GOODS_RECEIVED_NOT_INVOICED',
  'PURCHASE_PRICE_VARIANCE',
  'FIXED_ASSET_COST',
  'ACCUMULATED_DEPRECIATION',
  'DEPRECIATION_EXPENSE',
  'FIXED_ASSET_CLEARING',
  'GAIN_LOSS_ON_DISPOSAL',
  'IMPAIRMENT_LOSS',
  'REVALUATION_SURPLUS',
  'EMPLOYEE_PAYABLE',
  'SALES_REVENUE',
  'DEFAULT_EXPENSE',
  'OUTPUT_VAT',
  'INPUT_VAT',
  'WITHHOLDING_TAX_PAYABLE',
  'BANK_CHARGES',
  'FX_GAIN',
  'FX_LOSS',
  'UNREALIZED_FX_GAIN',
  'UNREALIZED_FX_LOSS',
  'INTERCOMPANY_RECEIVABLE',
  'INTERCOMPANY_PAYABLE',
] as const;
export type AccountMappingKey = (typeof ACCOUNT_MAPPING_KEYS)[number];

/** Numbered document families: JE journal, INV invoice, CN/DN credit & debit notes, RCP receipt, BILL, VCN/VDN vendor notes, PAY vendor payment. */
export const DOCUMENT_TYPES = [
  'JE',
  'INV',
  'CN',
  'DN',
  'RCP',
  'BILL',
  'VCN',
  'VDN',
  'PAY',
  'QT',
  'SO',
  'PR',
  'PO',
  'GR',
  'SRN',
  'PRN',
  'ADJ',
  'TRF',
  'CNT',
  'FA',
  'DEP',
  'BTX',
  'STM',
  'EXP',
  'ICT',
  'FXR',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
