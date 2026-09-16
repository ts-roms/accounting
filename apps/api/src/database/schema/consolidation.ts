import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CONSOLIDATION_METHODS, CONSOLIDATION_RUN_STATUSES } from '@accounting/types';
import { entityStatusEnum, primaryId, timestamps } from './_shared';
import { accountTypeEnum, accounts, money } from './accounting';
import { companies, organizations } from './organizations';
import { users } from './users';

export const consolidationMethodEnum = pgEnum('consolidation_method', CONSOLIDATION_METHODS);
export const consolidationRunStatusEnum = pgEnum(
  'consolidation_run_status',
  CONSOLIDATION_RUN_STATUSES,
);

/**
 * Consolidation readiness (hardening H9). A group names the parent, the
 * presentation currency and its members with ownership share and method; a
 * group chart of accounts receives every member account through mappings;
 * adjustments are the manual eliminations booked at group level only; runs
 * snapshot a consolidation so a finalised set of figures is reproducible.
 * Nothing here posts to any company ledger.
 */
export const consolidationGroups = pgTable(
  'consolidation_groups',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    presentationCurrency: char('presentation_currency', { length: 3 }).notNull(),
    parentCompanyId: uuid('parent_company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    status: entityStatusEnum('status').notNull().default('ACTIVE'),
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
    /** Parent's share, 0 < pct <= 100. */
    ownershipPct: numeric('ownership_pct', { precision: 7, scale: 4 }).notNull().default('100'),
    method: consolidationMethodEnum('method').notNull().default('FULL'),
  },
  (t) => [uniqueIndex('consolidation_group_members_uq').on(t.groupId, t.companyId)],
);

/** Group chart of accounts: the rows of the consolidated statements. */
export const groupAccounts = pgTable(
  'group_accounts',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => consolidationGroups.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    /** Balances on these accounts are eliminated automatically (intra-group receivables / payables / sales). */
    isIntercompany: boolean('is_intercompany').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('group_accounts_group_code_uq').on(t.groupId, t.code)],
);

/** Member account -> group account. One mapping per member account per group. */
export const groupAccountMappings = pgTable(
  'group_account_mappings',
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
    groupAccountId: uuid('group_account_id')
      .notNull()
      .references(() => groupAccounts.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('group_account_mappings_uq').on(t.groupId, t.accountId),
    index('group_account_mappings_company_idx').on(t.groupId, t.companyId),
  ],
);

/**
 * Manual consolidation adjustment (investment elimination, unrealised
 * profit, reclassification) in the presentation currency, applied to every
 * run whose window contains `effectiveDate`. Lines must balance.
 */
export const consolidationAdjustments = pgTable(
  'consolidation_adjustments',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => consolidationGroups.id, { onDelete: 'cascade' }),
    effectiveDate: date('effective_date').notNull(),
    /** Recurring adjustments re-apply in every later window until this date (inclusive); null = one window only. */
    recurringUntil: date('recurring_until'),
    reference: text('reference'),
    description: text('description').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('consolidation_adjustments_group_date_idx').on(t.groupId, t.effectiveDate)],
);

export const consolidationAdjustmentLines = pgTable(
  'consolidation_adjustment_lines',
  {
    id: primaryId(),
    adjustmentId: uuid('adjustment_id')
      .notNull()
      .references(() => consolidationAdjustments.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    groupAccountId: uuid('group_account_id')
      .notNull()
      .references(() => groupAccounts.id, { onDelete: 'restrict' }),
    debit: money('debit').notNull().default('0'),
    credit: money('credit').notNull().default('0'),
    description: text('description'),
  },
  (t) => [index('consolidation_adjustment_lines_adj_idx').on(t.adjustmentId)],
);

/** A stored consolidation: the report, the rates and the readiness result at the time it was built. */
export const consolidationRuns = pgTable(
  'consolidation_runs',
  {
    id: primaryId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => consolidationGroups.id, { onDelete: 'cascade' }),
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: consolidationRunStatusEnum('status').notNull().default('DRAFT'),
    report: jsonb('report').notNull(),
    readiness: jsonb('readiness').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    finalizedBy: uuid('finalized_by').references(() => users.id, { onDelete: 'set null' }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('consolidation_runs_group_idx').on(t.groupId, t.toDate)],
);

export type ConsolidationGroup = typeof consolidationGroups.$inferSelect;
export type ConsolidationGroupMember = typeof consolidationGroupMembers.$inferSelect;
export type GroupAccount = typeof groupAccounts.$inferSelect;
export type GroupAccountMapping = typeof groupAccountMappings.$inferSelect;
export type ConsolidationAdjustment = typeof consolidationAdjustments.$inferSelect;
export type ConsolidationAdjustmentLine = typeof consolidationAdjustmentLines.$inferSelect;
export type ConsolidationRun = typeof consolidationRuns.$inferSelect;
