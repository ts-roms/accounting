import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  BUDGET_STATUSES,
  BUDGET_VERSION_STATUSES,
  EXPENSE_CLAIM_STATUSES,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, fiscalPeriods, fiscalYears, journalEntries, money } from './accounting';
import { bankAccounts } from './assets-banking';
import { dimensionColumns } from './dimensions';
import { branches, companies } from './organizations';
import { taxCodes } from './tax';
import { users } from './users';

export const budgetStatusEnum = pgEnum('budget_status', BUDGET_STATUSES);
export const budgetVersionStatusEnum = pgEnum('budget_version_status', BUDGET_VERSION_STATUSES);
export const expenseClaimStatusEnum = pgEnum('expense_claim_status', EXPENSE_CLAIM_STATUSES);

// ------------------------------------------------------------------ budgets

/** A budget belongs to one fiscal year; its versions hold the numbers. */
export const budgets = pgTable(
  'budgets',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: budgetStatusEnum('status').notNull().default('DRAFT'),
    currency: char('currency', { length: 3 }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('budgets_company_code_uq').on(t.companyId, t.code),
    index('budgets_company_year_idx').on(t.companyId, t.fiscalYearId),
  ],
);

/** Versions are numbered per budget; approving one supersedes the previously approved version. */
export const budgetVersions = pgTable(
  'budget_versions',
  {
    id: primaryId(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    name: text('name').notNull(),
    notes: text('notes'),
    status: budgetVersionStatusEnum('status').notNull().default('DRAFT'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('budget_versions_number_uq').on(t.budgetId, t.versionNumber),
    // At most one approved version per budget.
    uniqueIndex('budget_versions_approved_uq')
      .on(t.budgetId)
      .where(sql`${t.status} = 'APPROVED'`),
  ],
);

export const budgetLines = pgTable(
  'budget_lines',
  {
    id: primaryId(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => budgetVersions.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    /** Signed in the account's natural direction: positive = budgeted revenue / expense. */
    amount: money('amount').notNull(),
    notes: text('notes'),
  },
  (t) => [
    unique('budget_lines_cell_uq')
      .on(t.versionId, t.accountId, t.fiscalPeriodId, t.departmentId, t.costCenterId, t.projectId)
      .nullsNotDistinct(),
    index('budget_lines_version_account_idx').on(t.versionId, t.accountId),
  ],
);

// ------------------------------------------------------------ expense claims

/**
 * Employee expense claims: submitted -> approved (by someone else) -> posted
 * (Dr expense / input tax, Cr employee payable) -> paid (Dr employee payable,
 * Cr bank). Business status only; the accounting effect is the two journals.
 */
export const expenseClaims = pgTable(
  'expense_claims',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    claimNumber: text('claim_number').notNull(),
    claimantUserId: uuid('claimant_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    claimDate: date('claim_date').notNull(),
    purpose: text('purpose').notNull(),
    notes: text('notes'),
    status: expenseClaimStatusEnum('status').notNull().default('DRAFT'),
    currency: char('currency', { length: 3 }).notNull(),
    /** Sum of gross line amounts (what the employee is owed). */
    total: money('total').notNull().default('0'),
    taxTotal: money('tax_total').notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    paymentJournalEntryId: uuid('payment_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    paymentBankAccountId: uuid('payment_bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'restrict',
    }),
    paymentDate: date('payment_date'),
    paymentReference: text('payment_reference'),
    rejectionReason: text('rejection_reason'),
    idempotencyKey: text('idempotency_key'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    paidBy: uuid('paid_by').references(() => users.id, { onDelete: 'set null' }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('expense_claims_company_number_uq').on(t.companyId, t.claimNumber),
    uniqueIndex('expense_claims_idempotency_uq').on(t.companyId, t.idempotencyKey),
    index('expense_claims_company_status_idx').on(t.companyId, t.status),
    index('expense_claims_claimant_idx').on(t.claimantUserId),
    check('expense_claims_total_chk', sql`${t.total} >= 0 AND ${t.taxTotal} >= 0 AND ${t.taxTotal} <= ${t.total}`),
  ],
);

export const expenseClaimLines = pgTable(
  'expense_claim_lines',
  {
    id: primaryId(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => expenseClaims.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    expenseDate: date('expense_date').notNull(),
    description: text('description').notNull(),
    merchant: text('merchant'),
    receiptReference: text('receipt_reference'),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    /** Gross amount reimbursed, tax inclusive. */
    amount: money('amount').notNull(),
    taxCodeId: uuid('tax_code_id').references(() => taxCodes.id, { onDelete: 'restrict' }),
    taxRate: money('tax_rate').notNull().default('0'),
    /** Tax carved out of the gross amount; the expense account gets amount - tax. */
    taxAmount: money('tax_amount').notNull().default('0'),
  },
  (t) => [
    uniqueIndex('expense_claim_lines_number_uq').on(t.claimId, t.lineNumber),
    check('expense_claim_lines_amount_chk', sql`${t.amount} > 0 AND ${t.taxAmount} >= 0 AND ${t.taxAmount} < ${t.amount}`),
  ],
);

export type Budget = typeof budgets.$inferSelect;
export type BudgetVersion = typeof budgetVersions.$inferSelect;
export type BudgetLine = typeof budgetLines.$inferSelect;
export type ExpenseClaim = typeof expenseClaims.$inferSelect;
export type ExpenseClaimLine = typeof expenseClaimLines.$inferSelect;
