/** Shared enumerations for fixed assets and banking (mirrored as PostgreSQL enums). */

export const DEPRECIATION_METHODS = ['STRAIGHT_LINE', 'DECLINING_BALANCE'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const ASSET_STATUSES = [
  /** Registered, not yet capitalised - no ledger effect. */
  'DRAFT',
  /** Capitalised and depreciating. */
  'ACTIVE',
  /** Book value has reached the salvage value. */
  'FULLY_DEPRECIATED',
  'DISPOSED',
  'WRITTEN_OFF',
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ASSET_EVENT_TYPES = [
  'CAPITALIZATION',
  'DEPRECIATION',
  'TRANSFER',
  'IMPAIRMENT',
  'REVALUATION',
  'DISPOSAL',
  'WRITE_OFF',
  /** Register-only: cost and accumulated depreciation carved out into child assets (Prompt #13). */
  'SPLIT',
] as const;
export type AssetEventType = (typeof ASSET_EVENT_TYPES)[number];

export const DEPRECIATION_RUN_STATUSES = ['DRAFT', 'POSTED', 'REVERSED'] as const;
export type DepreciationRunStatus = (typeof DEPRECIATION_RUN_STATUSES)[number];

export const BANK_TRANSACTION_TYPES = [
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER',
  'BANK_FEE',
  'INTEREST',
] as const;
export type BankTransactionType = (typeof BANK_TRANSACTION_TYPES)[number];

export const BANK_TRANSACTION_STATUSES = ['DRAFT', 'POSTED', 'VOID'] as const;
export type BankTransactionStatus = (typeof BANK_TRANSACTION_STATUSES)[number];

export const STATEMENT_STATUSES = ['OPEN', 'RECONCILED'] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

/** Outcome of the matching engine for one imported statement line. */
export const STATEMENT_LINE_STATUSES = [
  'UNMATCHED',
  /** Exactly one ledger candidate but not enough evidence for the configured auto-match confidence; a person confirms. */
  'POSSIBLE_MATCH',
  'MATCHED',
  'DUPLICATE',
  'EXCEPTION',
  'RECONCILED',
] as const;
export type StatementLineStatus = (typeof STATEMENT_LINE_STATUSES)[number];

/** AUTO: the statement matcher; MANUAL: a person; RULE: a bank feed rule / suggestion applied (Prompt #12). */
export const MATCH_KINDS = ['AUTO', 'MANUAL', 'RULE'] as const;

/** How sure the matching engine is about an automatic match. */
export const MATCH_CONFIDENCES = ['HIGH', 'MEDIUM'] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];
export type MatchKind = (typeof MATCH_KINDS)[number];

export const RECONCILIATION_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];
