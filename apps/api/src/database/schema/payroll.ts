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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  EMPLOYEE_PAYMENT_METHODS,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  PAY_FREQUENCIES,
  PAY_ITEM_CALCULATIONS,
  PAY_ITEM_STATUSES,
  PAY_ITEM_TYPES,
  PAY_RUN_STATUSES,
  type PayBracket,
} from '@accounting/types';
import { primaryId, timestamps } from './_shared';
import { accounts, journalEntries, money } from './accounting';
import { bankAccounts } from './assets-banking';
import { expenseClaims } from './budgeting';
import { dimensionColumns } from './dimensions';
import { branches, companies } from './organizations';
import { users } from './users';

/*
 * Payroll & employee expenses (Prompt #11).
 *
 * Employees and pay items are master data; a pay run calculates one payslip
 * per employee from the base salary, recurring assignments, company-wide
 * items and one-off inputs, then posts a single journal (Dr salary / employer
 * cost, Cr withholding / statutory payables / EMPLOYEE_PAYABLE net) and later
 * a payment (Dr EMPLOYEE_PAYABLE / Cr bank). The payslips are the subledger
 * of the employee payable account together with posted expense claims.
 */

export const employeeStatusEnum = pgEnum('employee_status', EMPLOYEE_STATUSES);
export const employmentTypeEnum = pgEnum('employment_type', EMPLOYMENT_TYPES);
export const payFrequencyEnum = pgEnum('pay_frequency', PAY_FREQUENCIES);
export const employeePaymentMethodEnum = pgEnum(
  'employee_payment_method',
  EMPLOYEE_PAYMENT_METHODS,
);
export const payItemTypeEnum = pgEnum('pay_item_type', PAY_ITEM_TYPES);
export const payItemCalculationEnum = pgEnum('pay_item_calculation', PAY_ITEM_CALCULATIONS);
export const payItemStatusEnum = pgEnum('pay_item_status', PAY_ITEM_STATUSES);
export const payRunStatusEnum = pgEnum('pay_run_status', PAY_RUN_STATUSES);

// ---------------------------------------------------------------- employees

export const employees = pgTable(
  'employees',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    employeeNumber: text('employee_number').notNull(),
    /** Application user (expense claims of this user can be reimbursed through payroll). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email'),
    jobTitle: text('job_title'),
    employmentType: employmentTypeEnum('employment_type').notNull().default('FULL_TIME'),
    payFrequency: payFrequencyEnum('pay_frequency').notNull().default('MONTHLY'),
    /** Base pay per pay period, company base currency. */
    baseSalary: money('base_salary').notNull(),
    hireDate: date('hire_date').notNull(),
    terminationDate: date('termination_date'),
    status: employeeStatusEnum('status').notNull().default('ACTIVE'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    taxIdentificationNumber: text('tax_identification_number'),
    paymentMethod: employeePaymentMethodEnum('payment_method').notNull().default('BANK'),
    bankName: text('bank_name'),
    bankAccountNumber: text('bank_account_number'),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('employees_company_number_uq').on(t.companyId, t.employeeNumber),
    uniqueIndex('employees_company_user_uq').on(t.companyId, t.userId),
    index('employees_company_status_idx').on(t.companyId, t.status),
    check('employees_salary_chk', sql`${t.baseSalary} >= 0`),
  ],
);
export type Employee = typeof employees.$inferSelect;

// ---------------------------------------------------------------- pay items

export const payItems = pgTable(
  'pay_items',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: payItemTypeEnum('type').notNull(),
    calculation: payItemCalculationEnum('calculation').notNull(),
    description: text('description'),
    amount: money('amount'),
    rate: money('rate'),
    maxBase: money('max_base'),
    brackets: jsonb('brackets').$type<PayBracket[]>().notNull().default([]),
    taxable: boolean('taxable').notNull().default(true),
    appliesToAll: boolean('applies_to_all').notNull().default(false),
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    liabilityAccountId: uuid('liability_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    sortOrder: integer('sort_order').notNull().default(100),
    status: payItemStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps,
  },
  (t) => [uniqueIndex('pay_items_company_code_uq').on(t.companyId, t.code)],
);
export type PayItem = typeof payItems.$inferSelect;

/** Recurring pay items assigned to one employee (allowances, loans, opt-in contributions). */
export const employeePayItems = pgTable(
  'employee_pay_items',
  {
    id: primaryId(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    payItemId: uuid('pay_item_id')
      .notNull()
      .references(() => payItems.id, { onDelete: 'restrict' }),
    amount: money('amount'),
    rate: money('rate'),
    effectiveFrom: date('effective_from').notNull(),
    effectiveTo: date('effective_to'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [index('employee_pay_items_employee_idx').on(t.employeeId)],
);
export type EmployeePayItem = typeof employeePayItems.$inferSelect;

export const payrollSettings = pgTable('payroll_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'cascade' }),
  defaultPayFrequency: payFrequencyEnum('default_pay_frequency').notNull().default('MONTHLY'),
  payrollBankAccountId: uuid('payroll_bank_account_id').references(
    (): AnyPgColumn => bankAccounts.id,
    { onDelete: 'set null' },
  ),
  reimburseExpenseClaims: boolean('reimburse_expense_claims').notNull().default(true),
  payDateReminderDays: integer('pay_date_reminder_days').notNull().default(3),
  ...timestamps,
});
export type PayrollSettings = typeof payrollSettings.$inferSelect;

// ----------------------------------------------------------------- pay runs

export const payRuns = pgTable(
  'pay_runs',
  {
    id: primaryId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    documentNumber: text('document_number').notNull(),
    payFrequency: payFrequencyEnum('pay_frequency').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    payDate: date('pay_date').notNull(),
    description: text('description'),
    status: payRunStatusEnum('status').notNull().default('DRAFT'),
    currency: text('currency').notNull(),
    employeeCount: integer('employee_count').notNull().default(0),
    grossTotal: money('gross_total').notNull().default('0'),
    taxableTotal: money('taxable_total').notNull().default('0'),
    withholdingTotal: money('withholding_total').notNull().default('0'),
    deductionTotal: money('deduction_total').notNull().default('0'),
    employerTotal: money('employer_total').notNull().default('0'),
    reimbursementTotal: money('reimbursement_total').notNull().default('0'),
    netTotal: money('net_total').notNull().default('0'),
    bankAccountId: uuid('bank_account_id').references((): AnyPgColumn => bankAccounts.id, {
      onDelete: 'restrict',
    }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    paymentJournalEntryId: uuid('payment_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    paymentDate: date('payment_date'),
    paymentReference: text('payment_reference'),
    reversalReason: text('reversal_reason'),
    calculatedAt: timestamp('calculated_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    paidBy: uuid('paid_by').references(() => users.id, { onDelete: 'set null' }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('pay_runs_company_number_uq').on(t.companyId, t.documentNumber),
    index('pay_runs_company_period_idx').on(t.companyId, t.periodEnd),
    index('pay_runs_company_status_idx').on(t.companyId, t.status),
    check('pay_runs_period_chk', sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);
export type PayRun = typeof payRuns.$inferSelect;

/** One-off amounts entered for a run (overtime, bonus, unpaid leave). */
export const payRunInputs = pgTable(
  'pay_run_inputs',
  {
    id: primaryId(),
    payRunId: uuid('pay_run_id')
      .notNull()
      .references(() => payRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    payItemId: uuid('pay_item_id')
      .notNull()
      .references(() => payItems.id, { onDelete: 'restrict' }),
    amount: money('amount').notNull(),
    note: text('note'),
    ...timestamps,
  },
  (t) => [index('pay_run_inputs_run_idx').on(t.payRunId)],
);
export type PayRunInput = typeof payRunInputs.$inferSelect;

export const payslips = pgTable(
  'payslips',
  {
    id: primaryId(),
    payRunId: uuid('pay_run_id')
      .notNull()
      .references(() => payRuns.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    /** Snapshot of the employee at calculation time. */
    employeeNumber: text('employee_number').notNull(),
    employeeName: text('employee_name').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    ...dimensionColumns(),
    baseSalary: money('base_salary').notNull(),
    gross: money('gross').notNull().default('0'),
    taxable: money('taxable').notNull().default('0'),
    withholding: money('withholding').notNull().default('0'),
    deductions: money('deductions').notNull().default('0'),
    employerContributions: money('employer_contributions').notNull().default('0'),
    reimbursements: money('reimbursements').notNull().default('0'),
    net: money('net').notNull().default('0'),
    paymentMethod: employeePaymentMethodEnum('payment_method').notNull().default('BANK'),
    bankName: text('bank_name'),
    bankAccountNumber: text('bank_account_number'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payslips_run_employee_uq').on(t.payRunId, t.employeeId),
    index('payslips_employee_idx').on(t.employeeId),
  ],
);
export type Payslip = typeof payslips.$inferSelect;

export const payslipLines = pgTable(
  'payslip_lines',
  {
    id: primaryId(),
    payslipId: uuid('payslip_id')
      .notNull()
      .references(() => payslips.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    /** Null for expense-claim reimbursements. */
    payItemId: uuid('pay_item_id').references(() => payItems.id, { onDelete: 'restrict' }),
    /** Expense claim reimbursed by this line. */
    expenseClaimId: uuid('expense_claim_id').references((): AnyPgColumn => expenseClaims.id, {
      onDelete: 'restrict',
    }),
    type: payItemTypeEnum('type').notNull(),
    code: text('code').notNull(),
    description: text('description').notNull(),
    amount: money('amount').notNull(),
    taxable: boolean('taxable').notNull().default(false),
    /** Account the line posts to, resolved at calculation from the item or the mapping: expense for earnings / employer contributions, liability for deductions / withholding. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** Employer contributions: the liability credited against the expense. */
    offsetAccountId: uuid('offset_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    /** Where the amount came from: BASE / ASSIGNMENT / COMPANY / INPUT / CLAIM. */
    source: text('source').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('payslip_lines_sequence_uq').on(t.payslipId, t.sequence)],
);
export type PayslipLine = typeof payslipLines.$inferSelect;
