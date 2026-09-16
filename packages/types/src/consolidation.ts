/*
 * Prompt #9 - multi-entity consolidation & intercompany. Enumerations shared
 * by the API, validation schemas and the web client.
 */

/** How a member entity enters the group figures. */
export const CONSOLIDATION_METHODS = ['FULL', 'PROPORTIONAL', 'EQUITY'] as const;
export type ConsolidationMethod = (typeof CONSOLIDATION_METHODS)[number];

/**
 * CURRENT_RATE: balance sheet at the closing rate, profit and loss at the
 * average rate, equity at historical rates, difference to the cumulative
 * translation adjustment. CLOSING_RATE: everything at the closing rate (no
 * translation difference, the pre-Prompt #9 behaviour).
 */
export const TRANSLATION_METHODS = ['CURRENT_RATE', 'CLOSING_RATE'] as const;
export type TranslationMethod = (typeof TRANSLATION_METHODS)[number];

export const CONSOLIDATION_GROUP_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type ConsolidationGroupStatus = (typeof CONSOLIDATION_GROUP_STATUSES)[number];

export const ELIMINATION_RULE_TYPES = [
  /** Intercompany receivables / payables (accounts flagged `isIntercompany`). */
  'INTERCOMPANY_BALANCES',
  /** Intercompany revenue against the counterparty's expense (configured account codes). */
  'INTERCOMPANY_PROFIT_LOSS',
  /** Parent investment against subsidiary equity at acquisition, goodwill and non-controlling interest. */
  'INVESTMENT_EQUITY',
  /** Unrealized profit in closing inventory bought from a group member. */
  'UNREALIZED_PROFIT',
  /** Fixed template lines applied every run (e.g. a recurring group reclassification). */
  'CUSTOM',
] as const;
export type EliminationRuleType = (typeof ELIMINATION_RULE_TYPES)[number];

export const CONSOLIDATION_RUN_STATUSES = ['DRAFT', 'FINALIZED'] as const;
export type ConsolidationRunStatus = (typeof CONSOLIDATION_RUN_STATUSES)[number];

export const CONSOLIDATION_ADJUSTMENT_TYPES = [
  'TRANSLATION',
  'ELIMINATION',
  'EQUITY_PICKUP',
  'NON_CONTROLLING_INTEREST',
  'MANUAL',
] as const;
export type ConsolidationAdjustmentType = (typeof CONSOLIDATION_ADJUSTMENT_TYPES)[number];

export const CONSOLIDATION_ADJUSTMENT_STATUSES = ['ACTIVE', 'VOID'] as const;
export type ConsolidationAdjustmentStatus = (typeof CONSOLIDATION_ADJUSTMENT_STATUSES)[number];

/** Rate kinds used by the translation engine. */
export const CONSOLIDATION_RATE_KINDS = ['CLOSING', 'AVERAGE', 'HISTORICAL'] as const;
export type ConsolidationRateKind = (typeof CONSOLIDATION_RATE_KINDS)[number];

export const INTERCOMPANY_MATCH_STATUSES = ['MATCHED', 'DIFFERENCE', 'ONE_SIDED'] as const;
export type IntercompanyMatchStatus = (typeof INTERCOMPANY_MATCH_STATUSES)[number];

/** Account codes the group posts consolidation entries to (resolved from the parent's mappings by default). */
export interface ConsolidationGroupAccounts {
  cumulativeTranslationAdjustment: string;
  nonControllingInterest: string;
  goodwill: string;
  retainedEarnings: string;
  /** Residual when intercompany balances do not mirror exactly (timing / FX). */
  intercompanyDifference: string;
  /** Equity-method share of associate results (P&L). */
  shareOfAssociateProfit: string;
  /** Parent's investment in subsidiaries / associates (balance sheet). */
  investment: string;
}

/** Per-type configuration stored on an elimination rule. */
export interface EliminationRuleConfig {
  /** INTERCOMPANY_PROFIT_LOSS: revenue codes in the selling entity and expense codes in the buying entity. */
  revenueCodes?: string[];
  expenseCodes?: string[];
  /** UNREALIZED_PROFIT: amount (presentation currency) and the inventory / cost of sales codes. */
  amount?: string;
  inventoryCode?: string;
  costOfSalesCode?: string;
  /** CUSTOM: fixed lines. */
  lines?: Array<{
    accountCode: string;
    debit?: string;
    credit?: string;
    description?: string;
    companyId?: string | null;
  }>;
}
