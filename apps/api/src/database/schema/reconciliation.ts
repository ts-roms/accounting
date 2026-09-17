import { sql } from 'drizzle-orm';
import {
  boolean,
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
  RECONCILIATION_AREAS,
  RECONCILIATION_EXCEPTION_STATUSES,
  SUBLEDGER_RECONCILIATION_STATUSES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, money } from './accounting';
import { companies } from './organizations';
import { users } from './users';

export const reconciliationAreaEnum = pgEnum('reconciliation_area', RECONCILIATION_AREAS);
export const subledgerReconciliationStatusEnum = pgEnum(
  'subledger_reconciliation_status',
  SUBLEDGER_RECONCILIATION_STATUSES,
);
export const reconciliationExceptionStatusEnum = pgEnum(
  'reconciliation_exception_status',
  RECONCILIATION_EXCEPTION_STATUSES,
);

/**
 * Company accounting policies (hardening). One row per company; created on
 * first read with defaults so the absence of a row never changes behaviour.
 */
export const accountingPolicies = pgTable('accounting_policies', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  /** Absolute variance up to which a reconciliation counts as reconciled. */
  reconciliationMateriality: money('reconciliation_materiality').notNull().default('0'),
  reconciliationStaleDays: integer('reconciliation_stale_days').notNull().default(35),
  /** Close blockers: which automatic checks must pass before a close is approved / completed. */
  closeRequireReconciliations: boolean('close_require_reconciliations').notNull().default(true),
  closeRequireBankReconciliation: boolean('close_require_bank_reconciliation')
    .notNull()
    .default(true),
  closeRequireDepreciation: boolean('close_require_depreciation').notNull().default(true),
  closeRequireFxRevaluation: boolean('close_require_fx_revaluation').notNull().default(false),
  /** Due deferred revenue must be recognized before the period closes (Prompt #10). */
  closeRequireRevenueRecognition: boolean('close_require_revenue_recognition')
    .notNull()
    .default(true),
  closeBlockOnUnapprovedJournals: boolean('close_block_on_unapproved_journals')
    .notNull()
    .default(true),
  closeBlockOnOpenExceptions: boolean('close_block_on_open_exceptions').notNull().default(true),
  closeRequireIntegrityOk: boolean('close_require_integrity_ok').notNull().default(true),
  /** Lock the period as the final step of a completed close. */
  closeLockOnComplete: boolean('close_lock_on_complete').notNull().default(false),
  /** A suspense balance requiring investigation blocks the close. */
  closeBlockOnSuspense: boolean('close_block_on_suspense').notNull().default(true),
  /** Absolute suspense balance above which investigation is required (0 = any balance). */
  suspenseMateriality: money('suspense_materiality').notNull().default('0'),
  /** Days a suspense balance may stay open before investigation is required. */
  suspenseMaxAgeDays: integer('suspense_max_age_days').notNull().default(30),
  ...timestamps,
});

/**
 * A recorded subledger-to-control reconciliation as of a date: the computed
 * balances are a snapshot, the lifecycle (review, exceptions, approval) is the
 * control. One record per company / area / control account / date.
 */
export const reconciliations = pgTable(
  'reconciliations',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    area: reconciliationAreaEnum('area').notNull(),
    asOf: date('as_of').notNull(),
    controlAccountId: uuid('control_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    status: subledgerReconciliationStatusEnum('status').notNull().default('IN_PROGRESS'),
    /** Balance derived from the subledger (documents, layers, register, tax register). */
    expectedBalance: money('expected_balance').notNull().default('0'),
    /** Control account balance in the general ledger. */
    actualBalance: money('actual_balance').notNull().default('0'),
    /** actual - expected. */
    variance: money('variance').notNull().default('0'),
    /** Policy in force when computed. */
    materiality: money('materiality').notNull().default('0'),
    /** Area-specific breakdown (per account / warehouse / tax code) for drill-down. */
    detail: jsonb('detail').notNull().default({}),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    preparedBy: uuid('prepared_by').references(() => users.id, { onDelete: 'set null' }),
    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('reconciliations_company_area_account_date_uq').on(
      t.companyId,
      t.area,
      t.controlAccountId,
      t.asOf,
    ),
    index('reconciliations_company_status_idx').on(t.companyId, t.status, t.asOf),
    check(
      'reconciliations_variance_chk',
      sql`${t.variance} = ${t.actualBalance} - ${t.expectedBalance}`,
    ),
  ],
);

/** An explained component of a variance. A material variance is only approvable once all are resolved. */
export const reconciliationExceptions = pgTable(
  'reconciliation_exceptions',
  {
    id: primaryId(),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => reconciliations.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    status: reconciliationExceptionStatusEnum('status').notNull().default('OPEN'),
    description: text('description').notNull(),
    /** Signed contribution to the variance (actual - expected). */
    amount: money('amount').notNull(),
    reference: text('reference'),
    raisedBy: uuid('raised_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolution: text('resolution'),
    ...timestamps,
  },
  (t) => [index('reconciliation_exceptions_recon_idx').on(t.reconciliationId, t.status)],
);

export type AccountingPolicy = typeof accountingPolicies.$inferSelect;
export type Reconciliation = typeof reconciliations.$inferSelect;
export type ReconciliationException = typeof reconciliationExceptions.$inferSelect;
