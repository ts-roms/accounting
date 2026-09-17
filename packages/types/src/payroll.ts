/*
 * Prompt #11 - payroll & employee expenses. Enumerations shared by the API,
 * validation schemas and the web client.
 */

export const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'TERMINATED'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const PAY_FREQUENCIES = ['MONTHLY', 'SEMI_MONTHLY', 'WEEKLY'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export const EMPLOYEE_PAYMENT_METHODS = ['BANK', 'CASH', 'CHECK'] as const;
export type EmployeePaymentMethod = (typeof EMPLOYEE_PAYMENT_METHODS)[number];

/**
 * EARNING adds to gross (and to taxable pay when the item is taxable).
 * DEDUCTION is withheld from the employee (statutory contributions, loans).
 * WITHHOLDING_TAX is the income tax withheld (progressive brackets).
 * EMPLOYER_CONTRIBUTION is the employer's own cost: an expense and a
 * liability, never part of the employee's gross or net.
 */
export const PAY_ITEM_TYPES = [
  'EARNING',
  'DEDUCTION',
  'WITHHOLDING_TAX',
  'EMPLOYER_CONTRIBUTION',
] as const;
export type PayItemType = (typeof PAY_ITEM_TYPES)[number];

/**
 * FIXED: the assigned / default amount per period. PERCENT_OF_GROSS: rate x
 * (gross capped at `maxBase`). BRACKET: progressive brackets over taxable pay
 * (withholding tax). BASE_SALARY: the employee's base pay for the period.
 */
export const PAY_ITEM_CALCULATIONS = [
  'FIXED',
  'PERCENT_OF_GROSS',
  'BRACKET',
  'BASE_SALARY',
] as const;
export type PayItemCalculation = (typeof PAY_ITEM_CALCULATIONS)[number];

export const PAY_ITEM_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PayItemStatus = (typeof PAY_ITEM_STATUSES)[number];

/**
 * DRAFT: created, nothing calculated yet. CALCULATED: payslips built, editable
 * inputs. APPROVED: locked, awaiting posting. POSTED: journal in the ledger,
 * net pay owed. PAID: bank payment posted. REVERSED: journal mirrored.
 */
export const PAY_RUN_STATUSES = [
  'DRAFT',
  'CALCULATED',
  'APPROVED',
  'POSTED',
  'PAID',
  'REVERSED',
] as const;
export type PayRunStatus = (typeof PAY_RUN_STATUSES)[number];

/** A progressive withholding bracket: taxable pay above `over` (per period) is taxed at `rate`% plus `base`. */
export interface PayBracket {
  over: string;
  base: string;
  rate: string;
}

/** Integrity checks run by `GET /payroll/integrity`. */
export const PAYROLL_INTEGRITY_CHECKS = [
  'EMPLOYEE_PAYABLE_VS_LEDGER',
  'PAYSLIP_TOTALS',
  'PAY_RUN_WITHOUT_JOURNAL',
  'PAY_RUNS_UNPAID',
] as const;
export type PayrollIntegrityCheck = (typeof PAYROLL_INTEGRITY_CHECKS)[number];
