import { P, type OrderStatus, type OrderType, type PermissionKey } from '@accounting/types';
import { AP_CONFIG, AR_CONFIG, type SubledgerConfig } from '@/lib/subledger/config';

export type OrderUiAction =
  'submit' | 'send' | 'accept' | 'approve' | 'reject' | 'confirm' | 'close' | 'cancel';

/**
 * Everything that differs between quotations, sales orders, purchase requests
 * and purchase orders on screen. One set of components renders all four.
 */
export interface OrderConfig {
  type: OrderType;
  singular: string;
  plural: string;
  path: string;
  api: string;
  /** Which subledger the order feeds (party picker, line account types, document paths). */
  subledger: SubledgerConfig;
  /** Purchase requests may be created without a vendor. */
  partyOptional: boolean;
  expectedDateLabel: string;
  permissions: { view: PermissionKey; create: PermissionKey; approve: PermissionKey };
  /** Lifecycle actions shown on the detail page: status they apply from, label, permission. */
  actions: Array<{
    action: OrderUiAction;
    from: OrderStatus[];
    label: string;
    permission: PermissionKey;
    needsReason?: boolean;
    primary?: boolean;
  }>;
  convert?: { label: string; targetPath: string; permission: PermissionKey; needsVendor: boolean };
  fulfil?: {
    label: string;
    documentSingular: string;
    documentPath: string;
    permission: PermissionKey;
  };
  tracksReceipts: boolean;
  tracksBilling: boolean;
  returns?: { path: string; api: string; singular: string; permission: PermissionKey };
}

export const QUOTATION_CONFIG: OrderConfig = {
  type: 'QUOTATION',
  singular: 'Quotation',
  plural: 'Quotations',
  path: '/sales/quotations',
  api: '/quotations',
  subledger: AR_CONFIG,
  partyOptional: false,
  expectedDateLabel: 'Valid until',
  permissions: {
    view: P['quotation.view'],
    create: P['quotation.create'],
    approve: P['quotation.create'],
  },
  actions: [
    {
      action: 'send',
      from: ['DRAFT'],
      label: 'Mark as sent',
      permission: P['quotation.create'],
      primary: true,
    },
    {
      action: 'accept',
      from: ['DRAFT', 'SENT'],
      label: 'Customer accepted',
      permission: P['quotation.create'],
      primary: true,
    },
    {
      action: 'reject',
      from: ['SENT', 'ACCEPTED'],
      label: 'Customer declined',
      permission: P['quotation.create'],
      needsReason: true,
    },
    {
      action: 'cancel',
      from: ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'],
      label: 'Cancel',
      permission: P['quotation.create'],
      needsReason: true,
    },
  ],
  convert: {
    label: 'Create sales order',
    targetPath: '/sales/orders',
    permission: P['sales-order.create'],
    needsVendor: false,
  },
  tracksReceipts: false,
  tracksBilling: false,
};

export const SALES_ORDER_CONFIG: OrderConfig = {
  type: 'SALES_ORDER',
  singular: 'Sales order',
  plural: 'Sales orders',
  path: '/sales/orders',
  api: '/sales-orders',
  subledger: AR_CONFIG,
  partyOptional: false,
  expectedDateLabel: 'Requested delivery',
  permissions: {
    view: P['sales-order.view'],
    create: P['sales-order.create'],
    approve: P['sales-order.approve'],
  },
  actions: [
    {
      action: 'submit',
      from: ['DRAFT', 'REJECTED'],
      label: 'Submit (credit check)',
      permission: P['sales-order.create'],
      primary: true,
    },
    {
      action: 'approve',
      from: ['DRAFT', 'SUBMITTED'],
      label: 'Approve',
      permission: P['sales-order.approve'],
      primary: true,
    },
    {
      action: 'reject',
      from: ['SUBMITTED'],
      label: 'Reject',
      permission: P['sales-order.approve'],
      needsReason: true,
    },
    {
      action: 'confirm',
      from: ['APPROVED'],
      label: 'Confirm with customer',
      permission: P['sales-order.create'],
      primary: true,
    },
    {
      action: 'close',
      from: ['APPROVED', 'CONFIRMED'],
      label: 'Close',
      permission: P['sales-order.create'],
    },
    {
      action: 'cancel',
      from: ['DRAFT', 'SUBMITTED', 'APPROVED', 'CONFIRMED', 'REJECTED'],
      label: 'Cancel',
      permission: P['sales-order.create'],
      needsReason: true,
    },
  ],
  fulfil: {
    label: 'Create invoice',
    documentSingular: 'Invoice',
    documentPath: '/sales/invoices',
    permission: P['invoice.create'],
  },
  tracksReceipts: false,
  tracksBilling: true,
  returns: {
    path: '/sales/returns',
    api: '/sales-returns',
    singular: 'Sales return',
    permission: P['sales-return.create'],
  },
};

export const PURCHASE_REQUEST_CONFIG: OrderConfig = {
  type: 'PURCHASE_REQUEST',
  singular: 'Purchase request',
  plural: 'Purchase requests',
  path: '/purchasing/requests',
  api: '/purchase-requests',
  subledger: AP_CONFIG,
  partyOptional: true,
  expectedDateLabel: 'Needed by',
  permissions: {
    view: P['purchase-request.view'],
    create: P['purchase-request.create'],
    approve: P['purchase-request.approve'],
  },
  actions: [
    {
      action: 'submit',
      from: ['DRAFT', 'REJECTED'],
      label: 'Submit for approval',
      permission: P['purchase-request.create'],
      primary: true,
    },
    {
      action: 'approve',
      from: ['SUBMITTED'],
      label: 'Approve',
      permission: P['purchase-request.approve'],
      primary: true,
    },
    {
      action: 'reject',
      from: ['SUBMITTED'],
      label: 'Reject',
      permission: P['purchase-request.approve'],
      needsReason: true,
    },
    {
      action: 'cancel',
      from: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
      label: 'Cancel',
      permission: P['purchase-request.create'],
      needsReason: true,
    },
  ],
  convert: {
    label: 'Create purchase order',
    targetPath: '/purchasing/orders',
    permission: P['purchase-order.create'],
    needsVendor: true,
  },
  tracksReceipts: false,
  tracksBilling: false,
};

export const PURCHASE_ORDER_CONFIG: OrderConfig = {
  type: 'PURCHASE_ORDER',
  singular: 'Purchase order',
  plural: 'Purchase orders',
  path: '/purchasing/orders',
  api: '/purchase-orders',
  subledger: AP_CONFIG,
  partyOptional: false,
  expectedDateLabel: 'Expected receipt',
  permissions: {
    view: P['purchase-order.view'],
    create: P['purchase-order.create'],
    approve: P['purchase-order.approve'],
  },
  actions: [
    {
      action: 'approve',
      from: ['DRAFT'],
      label: 'Approve',
      permission: P['purchase-order.approve'],
      primary: true,
    },
    { action: 'close', from: ['APPROVED'], label: 'Close', permission: P['purchase-order.create'] },
    {
      action: 'cancel',
      from: ['DRAFT', 'APPROVED'],
      label: 'Cancel',
      permission: P['purchase-order.create'],
      needsReason: true,
    },
  ],
  fulfil: {
    label: 'Create bill',
    documentSingular: 'Bill',
    documentPath: '/purchasing/bills',
    permission: P['bill.create'],
  },
  tracksReceipts: true,
  tracksBilling: true,
  returns: {
    path: '/purchasing/returns',
    api: '/purchase-returns',
    singular: 'Purchase return',
    permission: P['purchase-return.create'],
  },
};

export const ORDER_CONFIGS: Record<OrderType, OrderConfig> = {
  QUOTATION: QUOTATION_CONFIG,
  SALES_ORDER: SALES_ORDER_CONFIG,
  PURCHASE_REQUEST: PURCHASE_REQUEST_CONFIG,
  PURCHASE_ORDER: PURCHASE_ORDER_CONFIG,
};

export interface ReturnsConfig {
  type: 'SALES' | 'PURCHASE';
  singular: string;
  plural: string;
  path: string;
  api: string;
  order: OrderConfig;
  creditNoteLabel: string;
  creditNotePath: string;
  permissions: { view: PermissionKey; create: PermissionKey; approve: PermissionKey };
}

export const SALES_RETURNS_CONFIG: ReturnsConfig = {
  type: 'SALES',
  singular: 'Sales return',
  plural: 'Sales returns',
  path: '/sales/returns',
  api: '/sales-returns',
  order: SALES_ORDER_CONFIG,
  creditNoteLabel: 'Credit note',
  creditNotePath: '/sales/invoices',
  permissions: {
    view: P['sales-return.view'],
    create: P['sales-return.create'],
    approve: P['sales-return.approve'],
  },
};

export const PURCHASE_RETURNS_CONFIG: ReturnsConfig = {
  type: 'PURCHASE',
  singular: 'Purchase return',
  plural: 'Purchase returns',
  path: '/purchasing/returns',
  api: '/purchase-returns',
  order: PURCHASE_ORDER_CONFIG,
  creditNoteLabel: 'Vendor credit note',
  creditNotePath: '/purchasing/bills',
  permissions: {
    view: P['purchase-return.view'],
    create: P['purchase-return.create'],
    approve: P['purchase-return.approve'],
  },
};

export const GOODS_RECEIPTS_PATH = '/purchasing/receipts';
export const PURCHASING_SETTINGS_PATH = '/purchasing/settings';
