/** Shared accounting enumerations (mirrored as PostgreSQL enums). */

export const ACCOUNT_TYPES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'COST_OF_SALES',
  'EXPENSE',
  'OTHER_INCOME',
  'OTHER_EXPENSE',
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
  OTHER_INCOME: 'CREDIT',
  OTHER_EXPENSE: 'DEBIT',
};

export const BALANCE_SHEET_TYPES: readonly AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY'];
export const INCOME_STATEMENT_TYPES: readonly AccountType[] = [
  'REVENUE',
  'COST_OF_SALES',
  'EXPENSE',
  'OTHER_INCOME',
  'OTHER_EXPENSE',
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
  /** Clearing / unallocated balances that must be investigated and cleared (suspense monitor). */
  'SUSPENSE',
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

/**
 * GENERAL: day-to-day. ADJUSTING: period-end adjustments (also prepayment
 * recognition). ACCRUAL: accrued income / expense, usually auto-reversed on
 * the first day of the next period. RECLASSIFICATION: moves a balance between
 * accounts (e.g. clearing suspense). REVERSAL / CLOSING / OPENING are
 * engine-generated.
 */
export const JOURNAL_TYPES = [
  'GENERAL',
  'ADJUSTING',
  'ACCRUAL',
  'RECLASSIFICATION',
  'REVERSAL',
  'CLOSING',
  'OPENING',
] as const;
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
  /** Offset for opening-balance journals that do not balance on their own. */
  'OPENING_BALANCE_EQUITY',
  /** Default suspense / clearing account monitored by the suspense dashboard. */
  'SUSPENSE',
  'BAD_DEBT_EXPENSE',
  'ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS',
  'AR_WRITE_OFF',
  'BAD_DEBT_RECOVERY',
  /** Early-payment discounts taken on vendor bills (Prompt #7). */
  'PURCHASE_DISCOUNT',
  /** Period-end accrual for services received but not billed (Prompt #7). */
  'ACCRUED_EXPENSE',
  /** Clearing account for money between two bank accounts (Prompt #8). */
  'CASH_IN_TRANSIT',
  /** Group accounting (Prompt #9): parent's investment in subsidiaries / associates. */
  'INVESTMENT_IN_SUBSIDIARIES',
  'GOODWILL',
  'NON_CONTROLLING_INTEREST',
  'CUMULATIVE_TRANSLATION_ADJUSTMENT',
  /** Residual when intercompany balances do not mirror exactly. */
  'INTERCOMPANY_DIFFERENCE',
  /** Equity-method share of associate results. */
  'SHARE_OF_ASSOCIATE_PROFIT',
  /** Unearned revenue on invoices recognized over time (Prompt #10). */
  'DEFERRED_REVENUE',
  /** Payroll (Prompt #11): gross pay expense, employer contributions expense, statutory payables. */
  'SALARY_EXPENSE',
  'EMPLOYER_CONTRIBUTION_EXPENSE',
  'STATUTORY_CONTRIBUTIONS_PAYABLE',
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
  'DLV',
  'WO',
  'COL',
  'DSP',
  'RFD',
  'PRV',
  'STMT',
  /** Vendor payment run (Prompt #7). */
  'PMR',
  /** AP accrual run (Prompt #7). */
  'ACR',
  /** Bank transfer (Prompt #8). */
  'BTR',
  /** Petty cash voucher (Prompt #8). */
  'PCV',
  /** Bank payment file (Prompt #8). */
  'PMF',
  /** Consolidation run (Prompt #9). */
  'CON',
  /** Revenue recognition run (Prompt #10). */
  'RRN',
  /** Employee number and pay run (Prompt #11). */
  'EMP',
  'PYR',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

// ------------------------------------------------------- accounting core extensions

/** Cash-flow statement classification of a balance-sheet account (NULL = derived from subtype). */
export const CASH_FLOW_ACTIVITIES = ['OPERATING', 'INVESTING', 'FINANCING'] as const;
export type CashFlowActivity = (typeof CASH_FLOW_ACTIVITIES)[number];

export const RECURRING_FREQUENCIES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'QUARTERLY',
  'ANNUALLY',
] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

/**
 * DRAFT: each occurrence is created as a DRAFT journal for the normal
 * submit / approve / post workflow. AUTO_POST: occurrences post immediately;
 * choosing it requires `journal.post` and is audited on the template.
 */
export const RECURRING_JOURNAL_MODES = ['DRAFT', 'AUTO_POST'] as const;
export type RecurringJournalMode = (typeof RECURRING_JOURNAL_MODES)[number];

export const RECURRING_JOURNAL_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED'] as const;
export type RecurringJournalStatus = (typeof RECURRING_JOURNAL_STATUSES)[number];

export const PREPAYMENT_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type PrepaymentStatus = (typeof PREPAYMENT_STATUSES)[number];

export const PREPAYMENT_SCHEDULE_STATUSES = ['PENDING', 'RECOGNIZED', 'CANCELLED'] as const;
export type PrepaymentScheduleStatus = (typeof PREPAYMENT_SCHEDULE_STATUSES)[number];

export const POSTING_SIDES = ['DEBIT', 'CREDIT'] as const;
export type PostingSide = (typeof POSTING_SIDES)[number];

/**
 * How a posting-rule line finds its account: a company account mapping key,
 * a fixed account, or a key the calling module supplies at resolve time
 * (e.g. the revenue account of the product category on the line).
 */
export const POSTING_RULE_ACCOUNT_SOURCES = ['MAPPING', 'ACCOUNT', 'CONTEXT'] as const;
export type PostingRuleAccountSource = (typeof POSTING_RULE_ACCOUNT_SOURCES)[number];

/** What a dimension rule applies to. */
export const DIMENSION_RULE_SCOPES = ['ACCOUNT', 'ACCOUNT_TYPE', 'CODE_PREFIX'] as const;
export type DimensionRuleScope = (typeof DIMENSION_RULE_SCOPES)[number];
