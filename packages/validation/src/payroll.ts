import { z } from 'zod';
import {
  EMPLOYEE_PAYMENT_METHODS,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  PAY_FREQUENCIES,
  PAY_ITEM_CALCULATIONS,
  PAY_ITEM_STATUSES,
  PAY_ITEM_TYPES,
  PAY_RUN_STATUSES,
} from '@accounting/types';
import { amountSchema, isoDateSchema } from './accounting';
import { exchangeRateValueSchema } from './enterprise';
import { dimensionRefsSchema } from './dimensions';
import {
  codeSchema,
  nameSchema,
  optionalCurrencyCodeSchema,
  optionalText,
  paginationQuerySchema,
  uuidSchema,
} from './primitives';
import { percentSchema } from './subledger';

// ---------------------------------------------------------------- employees

export const createEmployeeSchema = dimensionRefsSchema
  .extend({
    /** Blank = allocated from the EMP numbering rule. */
    employeeNumber: codeSchema.optional(),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(200).nullable().optional(),
    /** Application user this employee is (for expense-claim reimbursement through payroll). */
    userId: uuidSchema.nullable().optional(),
    jobTitle: optionalText(120),
    employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
    payFrequency: z.enum(PAY_FREQUENCIES).default('MONTHLY'),
    /** Pay currency; omitted = the company base currency. */
    currency: optionalCurrencyCodeSchema,
    /** Base pay per pay period, in the pay currency. */
    baseSalary: amountSchema,
    hireDate: isoDateSchema,
    terminationDate: isoDateSchema.nullable().optional(),
    branchId: uuidSchema.nullable().optional(),
    taxIdentificationNumber: optionalText(40),
    paymentMethod: z.enum(EMPLOYEE_PAYMENT_METHODS).default('BANK'),
    bankName: optionalText(120),
    bankAccountNumber: optionalText(40),
    notes: optionalText(1000),
  })
  .refine((e) => !e.terminationDate || e.terminationDate >= e.hireDate, {
    message: 'Termination cannot precede the hire date',
    path: ['terminationDate'],
  });
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = dimensionRefsSchema.extend({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  userId: uuidSchema.nullable().optional(),
  jobTitle: optionalText(120),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  payFrequency: z.enum(PAY_FREQUENCIES).optional(),
  currency: optionalCurrencyCodeSchema,
  baseSalary: amountSchema.optional(),
  hireDate: isoDateSchema.optional(),
  terminationDate: isoDateSchema.nullable().optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  branchId: uuidSchema.nullable().optional(),
  taxIdentificationNumber: optionalText(40),
  paymentMethod: z.enum(EMPLOYEE_PAYMENT_METHODS).optional(),
  bankName: optionalText(120),
  bankAccountNumber: optionalText(40),
  notes: optionalText(1000),
  /** Why the record changed - kept with the field-level history. */
  changeReason: optionalText(500),
});
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const listEmployeesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  payFrequency: z.enum(PAY_FREQUENCIES).optional(),
  departmentId: uuidSchema.optional(),
});
export type ListEmployeesQuery = z.infer<typeof listEmployeesQuerySchema>;

/** A recurring pay item on an employee (allowance, loan deduction, ...). */
export const employeePayItemSchema = z
  .object({
    payItemId: uuidSchema,
    /** Overrides the item's default amount / rate for this employee. */
    amount: amountSchema.nullable().optional(),
    rate: percentSchema.nullable().optional(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullable().optional(),
    notes: optionalText(300),
  })
  .refine((a) => !a.effectiveTo || a.effectiveTo >= a.effectiveFrom, {
    message: 'Effective end precedes start',
    path: ['effectiveTo'],
  });
export type EmployeePayItemInput = z.infer<typeof employeePayItemSchema>;

// ---------------------------------------------------------------- pay items

export const payBracketSchema = z.object({
  over: amountSchema,
  base: amountSchema,
  rate: percentSchema,
});

export const createPayItemSchema = z
  .object({
    code: codeSchema,
    name: nameSchema,
    type: z.enum(PAY_ITEM_TYPES),
    calculation: z.enum(PAY_ITEM_CALCULATIONS),
    description: optionalText(500),
    /** FIXED: default amount per period. */
    amount: amountSchema.nullable().optional(),
    /** PERCENT_OF_GROSS: rate applied to gross capped at `maxBase`. */
    rate: percentSchema.nullable().optional(),
    maxBase: amountSchema.nullable().optional(),
    /** BRACKET: progressive brackets (ascending `over`). */
    brackets: z.array(payBracketSchema).max(20).optional(),
    /** EARNING only: counts towards taxable pay. */
    taxable: z.boolean().default(true),
    /** Applied to every employee of the company without an explicit assignment. */
    appliesToAll: z.boolean().default(false),
    /** EARNING / EMPLOYER_CONTRIBUTION: expense account (blank = mapping). */
    expenseAccountId: uuidSchema.nullable().optional(),
    /** DEDUCTION / WITHHOLDING_TAX / EMPLOYER_CONTRIBUTION: liability account (blank = mapping). */
    liabilityAccountId: uuidSchema.nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(999).default(100),
  })
  .superRefine((p, ctx) => {
    if (p.calculation === 'BRACKET') {
      if (!p.brackets?.length)
        ctx.addIssue({
          code: 'custom',
          path: ['brackets'],
          message: 'Bracket items need brackets',
        });
      else
        for (let i = 1; i < p.brackets.length; i += 1)
          if (Number(p.brackets[i]!.over) <= Number(p.brackets[i - 1]!.over))
            ctx.addIssue({ code: 'custom', path: ['brackets'], message: 'Brackets must ascend' });
    }
    if (p.calculation === 'PERCENT_OF_GROSS' && p.rate == null)
      ctx.addIssue({ code: 'custom', path: ['rate'], message: 'Percent items need a rate' });
    if (p.calculation === 'BASE_SALARY' && p.type !== 'EARNING')
      ctx.addIssue({
        code: 'custom',
        path: ['calculation'],
        message: 'Only earnings can be the base salary',
      });
  });
export type CreatePayItemInput = z.infer<typeof createPayItemSchema>;

export const updatePayItemSchema = z.object({
  name: nameSchema.optional(),
  description: optionalText(500),
  amount: amountSchema.nullable().optional(),
  rate: percentSchema.nullable().optional(),
  maxBase: amountSchema.nullable().optional(),
  brackets: z.array(payBracketSchema).max(20).optional(),
  taxable: z.boolean().optional(),
  appliesToAll: z.boolean().optional(),
  expenseAccountId: uuidSchema.nullable().optional(),
  liabilityAccountId: uuidSchema.nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  status: z.enum(PAY_ITEM_STATUSES).optional(),
});
export type UpdatePayItemInput = z.infer<typeof updatePayItemSchema>;

export const updatePayrollSettingsSchema = z.object({
  defaultPayFrequency: z.enum(PAY_FREQUENCIES).optional(),
  /** Bank account pay runs are paid from by default. */
  payrollBankAccountId: uuidSchema.nullable().optional(),
  /** Reimburse posted expense claims of linked employees through pay runs. */
  reimburseExpenseClaims: z.boolean().optional(),
  /** Remind when a calculated / approved run's pay date is this many days away. */
  payDateReminderDays: z.coerce.number().int().min(0).max(30).optional(),
});
export type UpdatePayrollSettingsInput = z.infer<typeof updatePayrollSettingsSchema>;

// ----------------------------------------------------------------- pay runs

export const createPayRunSchema = z
  .object({
    payFrequency: z.enum(PAY_FREQUENCIES),
    periodStart: isoDateSchema,
    periodEnd: isoDateSchema,
    payDate: isoDateSchema,
    description: optionalText(200),
    bankAccountId: uuidSchema.nullable().optional(),
    /** Pay currency of the run (employees paid in it); omitted = the company base currency. */
    currency: optionalCurrencyCodeSchema,
    /** Foreign-currency runs: rate override for the period end (1 unit = rate base units); the rate table otherwise. */
    exchangeRate: exchangeRateValueSchema.optional(),
  })
  .refine((r) => r.periodEnd >= r.periodStart, {
    message: 'Period end precedes start',
    path: ['periodEnd'],
  })
  .refine((r) => r.payDate >= r.periodStart, {
    message: 'Pay date precedes the period',
    path: ['payDate'],
  });
export type CreatePayRunInput = z.infer<typeof createPayRunSchema>;

/** One-off amounts for a run (overtime hours x rate as an amount, bonus, unpaid leave). */
export const payRunInputSchema = z.object({
  employeeId: uuidSchema,
  payItemId: uuidSchema,
  amount: amountSchema,
  note: optionalText(300),
});
export type PayRunInputInput = z.infer<typeof payRunInputSchema>;

export const setPayRunInputsSchema = z.object({
  inputs: z.array(payRunInputSchema).max(5000),
});
export type SetPayRunInputsInput = z.infer<typeof setPayRunInputsSchema>;

export const listPayRunsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PAY_RUN_STATUSES).optional(),
  payFrequency: z.enum(PAY_FREQUENCIES).optional(),
});
export type ListPayRunsQuery = z.infer<typeof listPayRunsQuerySchema>;

export const payPayRunSchema = z.object({
  paymentDate: isoDateSchema.optional(),
  bankAccountId: uuidSchema.optional(),
  /** Foreign-currency runs: rate of the payment (1 unit = rate base units); the rate table otherwise. */
  exchangeRate: exchangeRateValueSchema.optional(),
  reference: optionalText(100),
});
export type PayPayRunInput = z.infer<typeof payPayRunSchema>;

export const reversePayRunSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  reversalDate: isoDateSchema.optional(),
});
export type ReversePayRunInput = z.infer<typeof reversePayRunSchema>;

// ------------------------------------------------------------------ reports

export const payrollSummaryQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((q) => q.to >= q.from, { message: 'Period end precedes start', path: ['to'] });
export type PayrollSummaryQuery = z.infer<typeof payrollSummaryQuerySchema>;

export const employeeYtdQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type EmployeeYtdQuery = z.infer<typeof employeeYtdQuerySchema>;

export const payrollIntegrityQuerySchema = z.object({ asOf: isoDateSchema.optional() });
export type PayrollIntegrityQuery = z.infer<typeof payrollIntegrityQuerySchema>;
