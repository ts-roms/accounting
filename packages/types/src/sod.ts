import { P, type PermissionKey } from './permissions';

export const SOD_ENFORCEMENTS = ['BLOCK', 'WARN'] as const;
export type SodEnforcement = (typeof SOD_ENFORCEMENTS)[number];

export interface SodPolicyDefinition {
  name: string;
  description: string;
  /** Holding both permissions in one company scope is a conflict. */
  permissionA: PermissionKey;
  permissionB: PermissionKey;
  enforcement: SodEnforcement;
}

/**
 * Default segregation-of-duties policies seeded per organization. They are data,
 * not code - administrators may relax or tighten them per organization.
 */
export const DEFAULT_SOD_POLICIES: readonly SodPolicyDefinition[] = [
  {
    name: 'Journal creator vs approver',
    description: 'A user who creates journals should not approve them.',
    permissionA: P['journal.create'],
    permissionB: P['journal.approve'],
    enforcement: 'WARN',
  },
  {
    name: 'Journal approver vs poster',
    description: 'A user who approves journals should not post them.',
    permissionA: P['journal.approve'],
    permissionB: P['journal.post'],
    enforcement: 'WARN',
  },
  {
    name: 'Vendor bill creator vs payment approver',
    description: 'A user who enters vendor bills should not approve vendor payments.',
    permissionA: P['bill.create'],
    permissionB: P['vendor-payment.approve'],
    enforcement: 'WARN',
  },
  {
    name: 'Vendor master vs vendor payment',
    description: 'A user who maintains vendors should not post vendor payments.',
    permissionA: P['vendor.manage'],
    permissionB: P['vendor-payment.post'],
    enforcement: 'WARN',
  },
  {
    name: 'Period close vs period reopen',
    description: 'Closing and reopening periods should be separated.',
    permissionA: P['period.close'],
    permissionB: P['period.reopen'],
    enforcement: 'WARN',
  },
  {
    name: 'Invoice creator vs approver',
    description: 'A user who creates customer invoices should not approve them.',
    permissionA: P['invoice.create'],
    permissionB: P['invoice.approve'],
    enforcement: 'WARN',
  },
  {
    name: 'Bill creator vs approver',
    description: 'A user who enters vendor bills should not approve them.',
    permissionA: P['bill.create'],
    permissionB: P['bill.approve'],
    enforcement: 'WARN',
  },
  {
    name: 'Payment creator vs releaser',
    description: 'A user who records vendor payments should not release (post) them.',
    permissionA: P['vendor-payment.create'],
    permissionB: P['vendor-payment.post'],
    enforcement: 'WARN',
  },
  {
    name: 'Payment approver vs releaser',
    description: 'A user who approves vendor payments should not release (post) them.',
    permissionA: P['vendor-payment.approve'],
    permissionB: P['vendor-payment.post'],
    enforcement: 'WARN',
  },
  {
    name: 'Receipt creator vs poster',
    description: 'A user who records customer receipts should not post them.',
    permissionA: P['customer-payment.create'],
    permissionB: P['customer-payment.post'],
    enforcement: 'WARN',
  },
  {
    name: 'Expense claim submitter vs approver',
    description: 'A user who submits expense claims should not approve them.',
    permissionA: P['expense-claim.create'],
    permissionB: P['expense-claim.approve'],
    enforcement: 'WARN',
  },
  {
    name: 'Bank transfer creator vs approver',
    description: 'A user who drafts inter-account bank transfers must not approve them.',
    permissionA: P['bank-transfer.create'],
    permissionB: P['bank-transfer.approve'],
    enforcement: 'WARN',
  },
  {
    name: 'Petty cash preparer vs approver',
    description:
      'A user who prepares petty cash vouchers should not approve them above the fund limit.',
    permissionA: P['petty-cash.manage'],
    permissionB: P['petty-cash.approve'],
    enforcement: 'WARN',
  },
];
