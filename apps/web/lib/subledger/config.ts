import { P, type AccountType, type PermissionKey } from '@accounting/types';

/**
 * Everything that differs between the receivables and payables screens. The
 * pages and components are written once and parameterised with one of these.
 */
export interface SubledgerConfig {
  side: 'AR' | 'AP';
  title: string;
  party: { singular: string; plural: string; path: string; api: string; codePrefix: string };
  document: {
    singular: string;
    plural: string;
    path: string;
    api: string;
    creditNoteLabel: string;
    debitNoteLabel: string;
  };
  payment: { singular: string; plural: string; path: string; api: string; direction: string };
  reports: {
    agingApi: string;
    agingPath: string;
    reconciliationApi: string;
    agingTitle: string;
    scheduleApi?: string;
  };
  permissions: {
    partyView: PermissionKey;
    partyManage: PermissionKey;
    docView: PermissionKey;
    docCreate: PermissionKey;
    docApprove: PermissionKey;
    docPost: PermissionKey;
    docVoid: PermissionKey;
    payCreate: PermissionKey;
    payPost: PermissionKey;
  };
  /** Account types offered on document lines. */
  lineAccountTypes: AccountType[];
  /** Field on the party record holding the default line account. */
  defaultLineAccountField: 'defaultRevenueAccountId' | 'defaultExpenseAccountId';
}

export const AR_CONFIG: SubledgerConfig = {
  side: 'AR',
  title: 'Receivables',
  party: {
    singular: 'Customer',
    plural: 'Customers',
    path: '/sales/customers',
    api: '/customers',
    codePrefix: 'CUST-',
  },
  document: {
    singular: 'Invoice',
    plural: 'Invoices',
    path: '/sales/invoices',
    api: '/invoices',
    creditNoteLabel: 'Credit note',
    debitNoteLabel: 'Debit note',
  },
  payment: {
    singular: 'Receipt',
    plural: 'Receipts',
    path: '/sales/payments',
    api: '/customer-payments',
    direction: 'received from',
  },
  reports: {
    agingApi: '/reports/ar-aging',
    agingPath: '/reports/ar-aging',
    reconciliationApi: '/reports/ar-reconciliation',
    agingTitle: 'AR Aging',
  },
  permissions: {
    partyView: P['customer.view'],
    partyManage: P['customer.manage'],
    docView: P['invoice.view'],
    docCreate: P['invoice.create'],
    docApprove: P['invoice.approve'],
    docPost: P['invoice.post'],
    docVoid: P['invoice.void'],
    payCreate: P['customer-payment.create'],
    payPost: P['customer-payment.post'],
  },
  lineAccountTypes: ['REVENUE', 'LIABILITY', 'ASSET'],
  defaultLineAccountField: 'defaultRevenueAccountId',
};

export const AP_CONFIG: SubledgerConfig = {
  side: 'AP',
  title: 'Payables',
  party: {
    singular: 'Vendor',
    plural: 'Vendors',
    path: '/purchasing/vendors',
    api: '/vendors',
    codePrefix: 'VEND-',
  },
  document: {
    singular: 'Bill',
    plural: 'Bills',
    path: '/purchasing/bills',
    api: '/bills',
    creditNoteLabel: 'Vendor credit note',
    debitNoteLabel: 'Vendor debit note',
  },
  payment: {
    singular: 'Payment',
    plural: 'Payments',
    path: '/purchasing/payments',
    api: '/vendor-payments',
    direction: 'paid to',
  },
  reports: {
    agingApi: '/reports/ap-aging',
    agingPath: '/reports/ap-aging',
    reconciliationApi: '/reports/ap-reconciliation',
    agingTitle: 'AP Aging',
    scheduleApi: '/reports/ap-schedule',
  },
  permissions: {
    partyView: P['vendor.view'],
    partyManage: P['vendor.manage'],
    docView: P['bill.view'],
    docCreate: P['bill.create'],
    docApprove: P['bill.approve'],
    docPost: P['bill.post'],
    docVoid: P['bill.void'],
    payCreate: P['vendor-payment.create'],
    payPost: P['vendor-payment.post'],
  },
  lineAccountTypes: ['EXPENSE', 'COST_OF_SALES', 'ASSET', 'LIABILITY'],
  defaultLineAccountField: 'defaultExpenseAccountId',
};
