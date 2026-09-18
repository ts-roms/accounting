import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CONSOLIDATION_ADJUSTMENT_STATUSES,
  CONSOLIDATION_ADJUSTMENT_TYPES,
  CONSOLIDATION_GROUP_STATUSES,
  CONSOLIDATION_METHODS,
  CONSOLIDATION_RUN_STATUSES,
  ELIMINATION_RULE_TYPES,
  TRANSLATION_METHODS,
  type ConsolidationGroupAccounts,
  type EliminationRuleConfig,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, money } from './accounting';
import { rate } from './enterprise';
import { companies, organizations } from './organizations';
import { users } from './users';

/*
 * Prompt #9 - multi-entity consolidation. The group keeps its own
 * consolidation ledger (adjustments by account code, never entity account
 * ids) beside the members' books; the members' ledgers are read, never
 * written, by consolidation.
 */

export const consolidationMethodEnum = pgEnum('consolidation_method', CONSOLIDATION_METHODS);
export const translationMethodEnum = pgEnum('translation_method', TRANSLATION_METHODS);
export const consolidationGroupStatusEnum = pgEnum(
  'consolidation_group_status',
  CONSOLIDATION_GROUP_STATUSES,
);
export const eliminationRuleTypeEnum = pgEnum('elimination_rule_type', ELIMINATION_RULE_TYPES);
export const consolidationRunStatusEnum = pgEnum(
  'consolidation_run_status',
  CONSOLIDATION_RUN_STATUSES,
);
export const consolidationAdjustmentTypeEnum = pgEnum(
  'consolidation_adjustment_type',
  CONSOLIDATION_ADJUSTMENT_TYPES,
);
export const consolidationAdjustmentStatusEnum = pgEnum(
  'consolidation_adjustment_status',
  CONSOLIDATION_ADJUSTMENT_STATUSES,
);

// ------------------------------------------------------------------- groups

export const consolidationGroups = pgTable(
  'consolidation_groups',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    status: consolidationGroupStatusEnum('status').notNull().default('ACTIVE'),
    /** Presents the group: its chart codes and account mappings are the group's. */
    parentCompanyId: uuid('parent_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    presentationCurrency: char('presentation_currency', { length: 3 }).notNull(),
    translationMethod: translationMethodEnum('translation_method')
      .notNull()
      .default('CURRENT_RATE'),
    intercompanyTolerance: money('intercompany_tolerance').notNull().default('0'),
    requirePeriodsClosed: boolean('require_periods_closed').notNull().default(true),
    /** Account codes the consolidation ledger posts to (parent chart). */
    accounts: jsonb('accounts').$type<ConsolidationGroupAccounts>().notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('consolidation_groups_org_code_uq').on(t.organizationId, t.code)],
);

export const consolidationGroupMembers = pgTable(
  'consolidation_group_members',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => consolidationGroups.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    method: consolidationMethodEnum('method').notNull().default('FULL'),
    /** 0-100. */
    ownershipPercent: money('ownership_percent').notNull().default('100'),
    acquisitionDate: date('acquisition_date'),
    disposalDate: date('disposal_date'),
    /** Subsidiary equity at acquisition, in the member's currency. */
    acquisitionEquity: money('acquisition_equity').notNull().default('0'),
    /** Cost of the parent's investment, in the parent's currency. */
    investmentCost: money('investment_cost').notNull().default('0'),
    /** Member currency -> presentation currency at acquisition (null = rate table on the acquisition date). */
    historicalRate: rate('historical_rate'),
    sortOrder: integer('sort_order').notNull().default(0),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('consolidation_group_members_uq').on(t.groupId, t.companyId),
    check(
      'consolidation_group_members_percent_chk',
      sql`${t.ownershipPercent} >= 0 and ${t.ownershipPercent} <= 100`,
    ),
  ],
);

// ----------------------------------------------------------- chart mappings

/**
 * Explicit group chart mapping: a member account that does not share the
 * parent's code (a subsidiary with its own chart) rolls up to a parent
 * account code in the group figures. Members without mappings keep matching
 * by code, so identical charts need nothing here.
 */
export const consolidationAccountMappings = pgTable(
  'consolidation_account_mappings',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => consolidationGroups.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Code in the parent's chart the member account consolidates into. */
    groupAccountCode: text('group_account_code').notNull(),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('consolidation_account_mappings_uq').on(t.groupId, t.accountId),
    index('consolidation_account_mappings_company_idx').on(t.groupId, t.companyId),
  ],
);

// -------------------------------------------------------------------- rules

export const eliminationRules = pgTable(
  'elimination_rules',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => consolidationGroups.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: eliminationRuleTypeEnum('type').notNull(),
    description: text('description'),
    autoApply: boolean('auto_apply').notNull().default(true),
    active: boolean('active').notNull().default(true),
    config: jsonb('config').$type<EliminationRuleConfig>().notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('elimination_rules_group_code_uq').on(t.groupId, t.code)],
);

// --------------------------------------------------------------------- runs

/** Rates used for one member in a run (member currency -> presentation). */
export interface ConsolidationRunRates {
  [companyId: string]: { closing: string; average: string; historical: string; opening: string };
}

/** Frozen member trial balances at finalization (reproducibility even if an entity reopens later). */
export interface ConsolidationSnapshotRow {
  companyId: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isIntercompany: boolean;
  /** Cumulative balance at period end (balance-sheet accounts) in the member currency, natural sign. */
  closing: string;
  /** Cumulative balance at period start. */
  opening: string;
  /** Activity in the period (profit-and-loss accounts). */
  period: string;
}

export const consolidationRuns = pgTable(
  'consolidation_runs',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => consolidationGroups.id, { onDelete: 'restrict' }),
    documentNumber: text('document_number').notNull(),
    status: consolidationRunStatusEnum('status').notNull().default('DRAFT'),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    description: text('description'),
    rates: jsonb('rates').$type<ConsolidationRunRates>().notNull().default({}),
    /** Rates the preparer typed over the rate table. */
    rateOverrides: jsonb('rate_overrides').$type<ConsolidationRunRates>().notNull().default({}),
    snapshot: jsonb('snapshot').$type<ConsolidationSnapshotRow[]>(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
    preparedBy: uuid('prepared_by').references(() => users.id, { onDelete: 'set null' }),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    finalizedBy: uuid('finalized_by').references(() => users.id, { onDelete: 'set null' }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizeNote: text('finalize_note'),
    reopenedBy: uuid('reopened_by').references(() => users.id, { onDelete: 'set null' }),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenReason: text('reopen_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('consolidation_runs_group_number_uq').on(t.groupId, t.documentNumber),
    index('consolidation_runs_group_period_idx').on(t.groupId, t.periodEnd),
    check('consolidation_runs_period_chk', sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

export const consolidationAdjustments = pgTable(
  'consolidation_adjustments',
  {
    id: primaryId(),
    runId: uuid('run_id')
      .notNull()
      .references(() => consolidationRuns.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    type: consolidationAdjustmentTypeEnum('type').notNull(),
    status: consolidationAdjustmentStatusEnum('status').notNull().default('ACTIVE'),
    /** Rule that generated the entry (null = manual). */
    ruleId: uuid('rule_id').references(() => eliminationRules.id, { onDelete: 'set null' }),
    /** Member the entry concerns (translation, equity pickup, NCI); null = group-wide. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    reference: text('reference'),
    autoGenerated: boolean('auto_generated').notNull().default(false),
    totalDebit: money('total_debit').notNull().default('0'),
    totalCredit: money('total_credit').notNull().default('0'),
    voidReason: text('void_reason'),
    voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'set null' }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('consolidation_adjustments_run_seq_uq').on(t.runId, t.sequence),
    index('consolidation_adjustments_run_idx').on(t.runId, t.status),
  ],
);

export const consolidationAdjustmentLines = pgTable(
  'consolidation_adjustment_lines',
  {
    id: primaryId(),
    adjustmentId: uuid('adjustment_id')
      .notNull()
      .references(() => consolidationAdjustments.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    /** Member column the line lands in; null = the group column. */
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    accountCode: text('account_code').notNull(),
    accountName: text('account_name').notNull(),
    accountType: text('account_type').notNull(),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
    description: text('description'),
  },
  (t) => [
    uniqueIndex('consolidation_adjustment_lines_uq').on(t.adjustmentId, t.lineNumber),
    check(
      'consolidation_adjustment_lines_chk',
      sql`${t.debit} >= 0 and ${t.credit} >= 0 and (${t.debit} = 0 or ${t.credit} = 0)`,
    ),
  ],
);

export type ConsolidationGroup = typeof consolidationGroups.$inferSelect;
export type ConsolidationGroupMember = typeof consolidationGroupMembers.$inferSelect;
export type ConsolidationAccountMapping = typeof consolidationAccountMappings.$inferSelect;
export type EliminationRule = typeof eliminationRules.$inferSelect;
export type ConsolidationRun = typeof consolidationRuns.$inferSelect;
export type ConsolidationAdjustment = typeof consolidationAdjustments.$inferSelect;
export type ConsolidationAdjustmentLine = typeof consolidationAdjustmentLines.$inferSelect;
