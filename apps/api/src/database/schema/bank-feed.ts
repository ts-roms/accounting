import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  BANK_FEED_ACTIONS,
  BANK_FEED_RESULT_TYPES,
  BANK_RULE_DIRECTIONS,
  BANK_RULE_MATCH_MODES,
  BANK_RULE_STATUSES,
  BANK_SUGGESTION_CONFIDENCES,
  BANK_SUGGESTION_SOURCES,
  BANK_SUGGESTION_STATUSES,
  type BankSuggestionPayload,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, journalLines, money } from './accounting';
import { bankAccounts, bankStatementLines, bankTransactionTypeEnum } from './assets-banking';
import { dimensionColumns } from './dimensions';
import { branches, companies } from './organizations';
import { users } from './users';

/*
 * Bank feed auto-reconciliation (Prompt #12).
 *
 * Statement lines the matcher could not pair with an existing ledger line
 * get *suggestions*: a matching rule fired, an open invoice / bill explains
 * the amount, or the same description was explained the same way before.
 * Applying a suggestion creates and posts the document through its owning
 * service (bank transaction, customer receipt, vendor payment) and matches
 * the statement line to the resulting bank ledger line. Nothing here writes
 * journal rows itself.
 */

export const bankRuleDirectionEnum = pgEnum('bank_rule_direction', BANK_RULE_DIRECTIONS);
export const bankRuleMatchModeEnum = pgEnum('bank_rule_match_mode', BANK_RULE_MATCH_MODES);
export const bankRuleStatusEnum = pgEnum('bank_rule_status', BANK_RULE_STATUSES);
export const bankFeedActionEnum = pgEnum('bank_feed_action', BANK_FEED_ACTIONS);
export const bankSuggestionSourceEnum = pgEnum('bank_suggestion_source', BANK_SUGGESTION_SOURCES);
export const bankSuggestionConfidenceEnum = pgEnum(
  'bank_suggestion_confidence',
  BANK_SUGGESTION_CONFIDENCES,
);
export const bankSuggestionStatusEnum = pgEnum('bank_suggestion_status', BANK_SUGGESTION_STATUSES);
export const bankFeedResultTypeEnum = pgEnum('bank_feed_result_type', BANK_FEED_RESULT_TYPES);

export const bankMatchingRules = pgTable(
  'bank_matching_rules',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    priority: integer('priority').notNull().default(100),
    status: bankRuleStatusEnum('status').notNull().default('ACTIVE'),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'cascade',
    }),
    direction: bankRuleDirectionEnum('direction').notNull().default('ANY'),
    descriptionPattern: text('description_pattern'),
    descriptionMode: bankRuleMatchModeEnum('description_mode').notNull().default('CONTAINS'),
    referencePattern: text('reference_pattern'),
    referenceMode: bankRuleMatchModeEnum('reference_mode').notNull().default('CONTAINS'),
    amountMin: money('amount_min'),
    amountMax: money('amount_max'),
    action: bankFeedActionEnum('action').notNull(),
    transactionType: bankTransactionTypeEnum('transaction_type'),
    counterpartyAccountId: uuid('counterparty_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** Customer (RECEIVE_CUSTOMER) or vendor (PAY_VENDOR). */
    partyId: uuid('party_id'),
    memo: text('memo'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    autoApply: boolean('auto_apply').notNull().default(false),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('bank_matching_rules_company_idx').on(t.companyId, t.status, t.priority)],
);
export type BankMatchingRule = typeof bankMatchingRules.$inferSelect;

export const bankFeedSettings = pgTable('bank_feed_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  autoApplyRules: boolean('auto_apply_rules').notNull().default(true),
  autoApplyDocumentMatches: boolean('auto_apply_document_matches').notNull().default(false),
  staleAfterDays: integer('stale_after_days').notNull().default(7),
  historyMinOccurrences: integer('history_min_occurrences').notNull().default(2),
  ...timestamps,
});
export type BankFeedSettings = typeof bankFeedSettings.$inferSelect;

export const bankLineSuggestions = pgTable(
  'bank_line_suggestions',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    statementLineId: uuid('statement_line_id')
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: 'cascade' }),
    source: bankSuggestionSourceEnum('source').notNull(),
    action: bankFeedActionEnum('action').notNull(),
    ruleId: uuid('rule_id').references(() => bankMatchingRules.id, { onDelete: 'set null' }),
    confidence: bankSuggestionConfidenceEnum('confidence').notNull(),
    payload: jsonb('payload').$type<BankSuggestionPayload>().notNull(),
    explanation: text('explanation').notNull(),
    status: bankSuggestionStatusEnum('status').notNull().default('PENDING'),
    resultType: bankFeedResultTypeEnum('result_type'),
    /** Bank transaction / customer payment / vendor payment produced by applying. */
    resultId: uuid('result_id'),
    resultNumber: text('result_number'),
    journalLineId: uuid('journal_line_id').references(() => journalLines.id, {
      onDelete: 'set null',
    }),
    /** Null when a rule auto-applied it. */
    appliedBy: uuid('applied_by').references(() => users.id, { onDelete: 'set null' }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    dismissedBy: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('bank_line_suggestions_line_idx').on(t.statementLineId, t.status),
    index('bank_line_suggestions_company_status_idx').on(t.companyId, t.status),
  ],
);
export type BankLineSuggestion = typeof bankLineSuggestions.$inferSelect;
