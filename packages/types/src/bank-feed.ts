/*
 * Prompt #12 - bank feed auto-reconciliation. Enumerations shared by the
 * API, validation schemas and the web client.
 */

/** Which statement lines a rule looks at: money in, money out, or both. */
export const BANK_RULE_DIRECTIONS = ['IN', 'OUT', 'ANY'] as const;
export type BankRuleDirection = (typeof BANK_RULE_DIRECTIONS)[number];

/** How a rule's text pattern is applied to the line description / reference. */
export const BANK_RULE_MATCH_MODES = ['CONTAINS', 'STARTS_WITH', 'REGEX'] as const;
export type BankRuleMatchMode = (typeof BANK_RULE_MATCH_MODES)[number];

/**
 * What explaining a statement line does:
 * POST_TRANSACTION - record and post a bank transaction (fee, interest,
 * deposit, withdrawal) against a counterparty account;
 * RECEIVE_CUSTOMER - post a customer receipt allocated to open invoices;
 * PAY_VENDOR - post a vendor payment allocated to open bills;
 * IGNORE - the line needs no ledger entry (e.g. a bank's own reversal).
 */
export const BANK_FEED_ACTIONS = [
  'POST_TRANSACTION',
  'RECEIVE_CUSTOMER',
  'PAY_VENDOR',
  'IGNORE',
] as const;
export type BankFeedAction = (typeof BANK_FEED_ACTIONS)[number];

export const BANK_RULE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type BankRuleStatus = (typeof BANK_RULE_STATUSES)[number];

/**
 * RULE - a matching rule fired. DOCUMENT - an open invoice / bill explains
 * the amount (number in the text, or a unique open balance). HISTORY - lines
 * with the same normalized description were explained the same way before.
 * MANUAL - entered by a person from the review queue.
 */
export const BANK_SUGGESTION_SOURCES = ['RULE', 'DOCUMENT', 'HISTORY', 'MANUAL'] as const;
export type BankSuggestionSource = (typeof BANK_SUGGESTION_SOURCES)[number];

export const BANK_SUGGESTION_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type BankSuggestionConfidence = (typeof BANK_SUGGESTION_CONFIDENCES)[number];

export const BANK_SUGGESTION_STATUSES = ['PENDING', 'APPLIED', 'DISMISSED', 'SUPERSEDED'] as const;
export type BankSuggestionStatus = (typeof BANK_SUGGESTION_STATUSES)[number];

/** What applying a suggestion produced. */
export const BANK_FEED_RESULT_TYPES = [
  'BANK_TRANSACTION',
  'CUSTOMER_PAYMENT',
  'VENDOR_PAYMENT',
  'IGNORED',
] as const;
export type BankFeedResultType = (typeof BANK_FEED_RESULT_TYPES)[number];

/** The concrete instruction a suggestion carries; validated again when applied. */
export interface BankSuggestionPayload {
  action: BankFeedAction;
  /** POST_TRANSACTION */
  transactionType?: 'DEPOSIT' | 'WITHDRAWAL' | 'BANK_FEE' | 'INTEREST';
  counterpartyAccountId?: string | null;
  memo?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  /** RECEIVE_CUSTOMER / PAY_VENDOR */
  partyId?: string | null;
  partyName?: string | null;
  allocations?: Array<{ documentId: string; documentNumber: string; amount: string }>;
}

/** Integrity checks run by `GET /banking/feed/integrity`. */
export const BANK_FEED_INTEGRITY_CHECKS = [
  'APPLIED_WITHOUT_MATCH',
  'STALE_UNMATCHED_LINES',
  'RULES_WITHOUT_ACCOUNT',
] as const;
export type BankFeedIntegrityCheck = (typeof BANK_FEED_INTEGRITY_CHECKS)[number];
