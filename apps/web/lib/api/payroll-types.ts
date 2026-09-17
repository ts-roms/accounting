/* API response shapes for payroll & employee expenses (Prompt #11). */
import type {
  EmployeePaymentMethod,
  EmployeeStatus,
  EmploymentType,
  PayBracket,
  PayFrequency,
  PayItemCalculation,
  PayItemStatus,
  PayItemType,
  PayRunStatus,
} from '@accounting/types';
import type { IntegrityReport } from './types';

export interface Employee {
  id: string;
  companyId: string;
  employeeNumber: string;
  userId: string | null;
  userEmail: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  jobTitle: string | null;
  employmentType: EmploymentType;
  payFrequency: PayFrequency;
  baseSalary: string;
  hireDate: string;
  terminationDate: string | null;
  status: EmployeeStatus;
  branchId: string | null;
  departmentId: string | null;
  departmentName: string | null;
  costCenterId: string | null;
  projectId: string | null;
  taxIdentificationNumber: string | null;
  paymentMethod: EmployeePaymentMethod;
  bankName: string | null;
  bankAccountNumber: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeePayItemAssignment {
  id: string;
  employeeId: string;
  payItemId: string;
  payItemCode: string;
  payItemName: string;
  payItemType: string;
  amount: string | null;
  rate: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
}

export interface EmployeeDetail extends Employee {
  payItems: EmployeePayItemAssignment[];
}

export interface PayItem {
  id: string;
  code: string;
  name: string;
  type: PayItemType;
  calculation: PayItemCalculation;
  description: string | null;
  amount: string | null;
  rate: string | null;
  maxBase: string | null;
  brackets: PayBracket[];
  taxable: boolean;
  appliesToAll: boolean;
  expenseAccountId: string | null;
  liabilityAccountId: string | null;
  expenseAccountCode: string | null;
  liabilityAccountCode: string | null;
  sortOrder: number;
  status: PayItemStatus;
}

export interface PayrollSettings {
  companyId: string;
  defaultPayFrequency: PayFrequency;
  payrollBankAccountId: string | null;
  reimburseExpenseClaims: boolean;
  payDateReminderDays: number;
}

export interface PayRun {
  id: string;
  documentNumber: string;
  payFrequency: PayFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  description: string | null;
  status: PayRunStatus;
  currency: string;
  employeeCount: number;
  grossTotal: string;
  taxableTotal: string;
  withholdingTotal: string;
  deductionTotal: string;
  employerTotal: string;
  reimbursementTotal: string;
  netTotal: string;
  bankAccountId: string | null;
  bankAccountCode: string | null;
  journalEntryId: string | null;
  journalNumber: string | null;
  paymentJournalEntryId: string | null;
  paymentJournalNumber: string | null;
  reversalJournalEntryId: string | null;
  paymentDate: string | null;
  paymentReference: string | null;
  reversalReason: string | null;
  calculatedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  postedAt: string | null;
  paidAt: string | null;
  reversedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface PayslipLine {
  id: string;
  sequence: number;
  payItemId: string | null;
  expenseClaimId: string | null;
  type: PayItemType;
  code: string;
  description: string;
  amount: string;
  taxable: boolean;
  source: string;
}

export interface Payslip {
  id: string;
  payRunId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  departmentId: string | null;
  baseSalary: string;
  gross: string;
  taxable: string;
  withholding: string;
  deductions: string;
  employerContributions: string;
  reimbursements: string;
  net: string;
  paymentMethod: EmployeePaymentMethod;
  bankName: string | null;
  bankAccountNumber: string | null;
  lines: PayslipLine[];
}

export interface PayRunInputRow {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  payItemId: string;
  payItemCode: string;
  amount: string;
  note: string | null;
}

export interface PayRunDetail extends PayRun {
  payslips: Payslip[];
  inputs: PayRunInputRow[];
}

export interface PayslipDetail extends Payslip {
  run: PayRun;
}

export interface PayrollSummary {
  from: string;
  to: string;
  currency: string;
  runs: number;
  employees: number;
  gross: string;
  withholding: string;
  deductions: string;
  employerContributions: string;
  reimbursements: string;
  net: string;
  employerCost: string;
  byDepartment: Array<{
    departmentId: string | null;
    department: string;
    employees: number;
    gross: string;
    employerContributions: string;
    employerCost: string;
  }>;
  byItem: Array<{ code: string; description: string; type: string; amount: string }>;
  byMonth: Array<{ month: string; runs: number; gross: string; withholding: string; net: string }>;
}

export interface WithholdingRemittance {
  from: string;
  to: string;
  currency: string;
  rows: Array<{
    month: string;
    employees: number;
    taxable: string;
    withholding: string;
    runs: string[];
  }>;
  total: string;
}

export interface EmployeeYtd {
  employeeId: string;
  year: number;
  currency: string;
  payslips: number;
  gross: string;
  taxable: string;
  withholding: string;
  deductions: string;
  employerContributions: string;
  net: string;
  byItem: Array<{ code: string; type: string; amount: string }>;
}

export type PayrollIntegrityReport = IntegrityReport;
