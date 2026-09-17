/**
 * Delegated authority (Prompt #4). A delegation lends a *subset* of the
 * delegator's approval permissions to another user for a bounded window,
 * scoped to one company (optionally a branch) and capped by amount. It is
 * never a role change: the delegate acts "on behalf of" and every use is
 * recorded.
 */
import type { PermissionKey } from './permissions';

export const DELEGATION_STATUSES = [
  'PENDING',
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
  'CANCELLED',
  'REJECTED',
] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export const DELEGATION_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type DelegationDecision = (typeof DELEGATION_DECISIONS)[number];

/** Organization policy: who must approve a delegation before it activates. */
export const DELEGATION_APPROVAL_POLICIES = [
  'SELF_SERVICE',
  'MANAGER_APPROVAL',
  'ADMIN_APPROVAL',
  'DUAL_APPROVAL',
] as const;
export type DelegationApprovalPolicy = (typeof DELEGATION_APPROVAL_POLICIES)[number];

/**
 * Only approval-type authority can be delegated. Posting, configuration and
 * administration permissions are deliberately excluded: a delegation must
 * never become a privilege-escalation mechanism.
 */
export const DELEGABLE_PERMISSION_DEFINITIONS = [
  ['bill.approve', 'Approve vendor bills', 'Accounts Payable'],
  ['vendor-payment.approve', 'Approve vendor payments', 'Accounts Payable'],
  ['invoice.approve', 'Approve customer invoices', 'Accounts Receivable'],
  ['expense-claim.approve', 'Approve expense claims', 'Expenses'],
  ['purchase-request.approve', 'Approve purchase requests', 'Purchasing'],
  ['purchase-order.approve', 'Approve purchase orders', 'Purchasing'],
  ['purchase-return.approve', 'Approve purchase returns / vendor credit notes', 'Purchasing'],
  ['sales-order.approve', 'Approve sales orders', 'Sales'],
  ['sales-return.approve', 'Approve sales returns / customer credit notes', 'Sales'],
  ['customer-payment.approve', 'Approve customer payments', 'Accounts Receivable'],
  ['customer-refund.approve', 'Approve customer refunds', 'Accounts Receivable'],
  ['write-off.approve', 'Approve receivable write-offs', 'Accounts Receivable'],
  ['payment-run.approve', 'Approve vendor payment runs', 'Accounts Payable'],
  ['vendor.approve', 'Approve vendor onboarding', 'Accounts Payable'],
  ['bank-transfer.approve', 'Approve bank transfers', 'Treasury'],
  ['petty-cash.approve', 'Approve petty cash vouchers', 'Treasury'],
  ['consolidation.approve', 'Finalize consolidation runs', 'Group'],
  ['payroll.approve', 'Approve pay runs', 'Payroll'],
  ['journal.approve', 'Approve journal entries', 'General Ledger'],
  ['budget.approve', 'Approve budget versions', 'Budgeting'],
  ['approval.decide', 'Decide workflow approval requests', 'Workflows'],
] as const satisfies ReadonlyArray<readonly [PermissionKey, string, string]>;

export type DelegablePermission = (typeof DELEGABLE_PERMISSION_DEFINITIONS)[number][0];
export const DELEGABLE_PERMISSIONS = DELEGABLE_PERMISSION_DEFINITIONS.map(
  (d) => d[0],
) as readonly DelegablePermission[];

export function isDelegablePermission(value: string): value is DelegablePermission {
  return (DELEGABLE_PERMISSIONS as readonly string[]).includes(value);
}

/** Document families a delegated approval can be exercised on (for usage records). */
export const DELEGATION_DOCUMENT_TYPES = [
  'VENDOR_BILL',
  'VENDOR_PAYMENT',
  'INVOICE',
  'EXPENSE_CLAIM',
  'PURCHASE_REQUEST',
  'PURCHASE_ORDER',
  'SALES_ORDER',
  'ORDER',
  'JOURNAL_ENTRY',
  'BUDGET_VERSION',
  'APPROVAL_REQUEST',
  'CUSTOMER_PAYMENT',
  'CUSTOMER_REFUND',
  'WRITE_OFF',
  'PAYMENT_RUN',
  'VENDOR',
  'BANK_TRANSFER',
  'PETTY_CASH_VOUCHER',
  'CONSOLIDATION_RUN',
  'PAY_RUN',
] as const;
export type DelegationDocumentType = (typeof DELEGATION_DOCUMENT_TYPES)[number];

/** Grant the auth guard attaches to a principal for the active company. */
export interface DelegatedGrant {
  delegationId: string;
  delegationNumber: string;
  delegatorUserId: string;
  delegatorName: string;
  permission: DelegablePermission;
  companyId: string;
  branchId: string | null;
  maxAmount: string | null;
  currency: string | null;
  startAt: string;
  endAt: string;
}
