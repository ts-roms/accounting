import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  ArrowLeftRight,
  BadgePercent,
  FileUp,
  Hash,
  Banknote,
  BarChart3,
  CalendarCheck,
  Bell,
  BookOpenText,
  Boxes,
  Building2,
  Cable,
  ClipboardCheck,
  ClipboardList,
  Coins,
  FileQuestion,
  FileCode2,
  FileText,
  GitBranch,
  Inbox,
  KeyRound,
  FileMinus,
  FilePlus,
  FileX,
  MessageSquareWarning,
  PhoneCall,
  Landmark,
  Network,
  Hourglass,
  Layers,
  LayoutDashboard,
  MessageSquareText,
  Package,
  PackageCheck,
  PieChart,
  Receipt,
  Scale,
  ScanText,
  ScrollText,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  Siren,
  SlidersHorizontal,
  Sparkles,
  Truck,
  Undo2,
  UserCheck,
  Users,
  Vault,
  Wallet,
  Webhook,
  Workflow,
} from 'lucide-react';
import { P, type PermissionKey } from '@accounting/types';

export interface NavItem {
  title: string;
  href: string;
  icon?: LucideIcon;
  /** Any of these permissions grants visibility. Empty = always visible. */
  permissions?: PermissionKey[];
  /** Roadmap phase for modules not yet implemented (renders a placeholder). */
  phase?: number;
  /** Optional sub-heading inside the section (e.g. Operations > Sales). */
  group?: string;
}

export interface NavSection {
  title: string;
  icon: LucideIcon;
  items: NavItem[];
}

const item = (
  title: string,
  href: string,
  icon: LucideIcon,
  permissions?: PermissionKey[],
  group?: string,
): NavItem => ({ title, href, icon, permissions, group });

/**
 * Application navigation, grouped the way finance teams think about the
 * platform: ledger, receivables, payables, operations, finance, reporting,
 * administration. Items whose `phase` is set render a roadmap placeholder
 * until that phase ships. The backend enforces permissions - this list only
 * shapes the menu.
 */
export const NAVIGATION: NavSection[] = [
  {
    title: 'Overview',
    icon: LayoutDashboard,
    items: [item('Dashboard', '/dashboard', LayoutDashboard)],
  },
  {
    title: 'Accounting',
    icon: BookOpenText,
    items: [
      item('General Ledger', '/accounting/general-ledger', ClipboardList, [P['journal.view']]),
      item('Journal Entries', '/accounting/journal-entries', FileText, [P['journal.view']]),
      item('Chart of Accounts', '/accounting/chart-of-accounts', BookOpenText, [P['account.view']]),
      item('Trial Balance', '/accounting/trial-balance', Scale, [P['reports.view']]),
      item('Period Closing', '/accounting/period-closing', Landmark, [P['period.view']]),
      item('Financial Close', '/accounting/financial-close', ClipboardCheck, [P['close.view']]),
      item('Opening Balances', '/accounting/opening-balances', Scale, [P['opening-balance.view']]),
      item('Reconciliation Center', '/accounting/reconciliation', Scale, [
        P['reconciliation.view'],
      ]),
      item('Integrity', '/accounting/integrity', ShieldCheck, [P['integrity.check']]),
      item('Control Center', '/accounting/control-center', LayoutDashboard, [P['controls.view']]),
      item('Journal Control', '/accounting/journal-control', ScrollText, [P['journal.view']]),
      item('Suspense Accounts', '/accounting/suspense', Siren, [P['controls.view']]),
      item('Recurring Journals', '/accounting/recurring-journals', Workflow, [
        P['recurring-journal.view'],
      ]),
      item('Prepayments', '/accounting/prepayments', Wallet, [P['prepayment.view']]),
      item('Posting Rules', '/accounting/posting-rules', SlidersHorizontal, [
        P['posting-rule.view'],
      ]),
      item('Exchange Rates', '/accounting/exchange-rates', Coins, [P['exchange-rate.view']]),
      item('FX Revaluation', '/accounting/fx-revaluation', Scale, [P['exchange-rate.view']]),
    ],
  },
  {
    title: 'Receivables',
    icon: Receipt,
    items: [
      item('AR Dashboard', '/receivables/dashboard', LayoutDashboard, [P['reports.view']]),
      item('Customers', '/sales/customers', Users, [P['customer.view']], 'Customers'),
      item(
        'Customer Statements',
        '/receivables/statements',
        FileText,
        [P['customer.view']],
        'Customers',
      ),
      item('Deliveries', '/receivables/deliveries', Truck, [P['delivery.view']], 'Billing'),
      item('Invoices', '/sales/invoices', Receipt, [P['invoice.view']], 'Billing'),
      item('Credit Notes', '/receivables/credit-notes', FileMinus, [P['invoice.view']], 'Billing'),
      item('Debit Notes', '/receivables/debit-notes', FilePlus, [P['invoice.view']], 'Billing'),
      item('Sales Returns', '/sales/returns', Undo2, [P['sales-return.view']], 'Billing'),
      item('Customer Payments', '/sales/payments', Wallet, [P['invoice.view']], 'Cash'),
      item('Refunds', '/receivables/refunds', Undo2, [P['invoice.view']], 'Cash'),
      item(
        'Collections',
        '/receivables/collections',
        PhoneCall,
        [P['collection.view']],
        'Collections',
      ),
      item(
        'Disputes',
        '/receivables/disputes',
        MessageSquareWarning,
        [P['collection.view']],
        'Collections',
      ),
      item('Write-Offs', '/receivables/write-offs', FileX, [P['write-off.view']], 'Collections'),
      item('Revenue Schedules', '/revenue/schedules', Hourglass, [P['revenue.view']], 'Revenue'),
      item('Recognition Runs', '/revenue/runs', CalendarCheck, [P['revenue.view']], 'Revenue'),
      item('Deferred Revenue', '/revenue/reports', ClipboardList, [P['revenue.view']], 'Revenue'),
      item('Revenue Policies', '/revenue/policies', Settings2, [P['revenue.view']], 'Revenue'),
      item('AR Aging', '/reports/ar-aging', ClipboardList, [P['reports.view']], 'Control'),
      item(
        'AR Reconciliation',
        '/receivables/reconciliation',
        Scale,
        [P['reports.view']],
        'Control',
      ),
      item(
        'Receivables Settings',
        '/receivables/settings',
        Settings2,
        [P['customer.view']],
        'Control',
      ),
    ],
  },
  {
    title: 'Payables',
    icon: Truck,
    items: [
      item('AP Dashboard', '/payables/dashboard', LayoutDashboard, [P['reports.view']]),
      item('Vendors', '/purchasing/vendors', Building2, [P['vendor.view']], 'Vendors'),
      item('Vendor Statements', '/payables/statements', FileText, [P['vendor.view']], 'Vendors'),
      item('Bills', '/purchasing/bills', FileText, [P['bill.view']], 'Bills'),
      item('Payment Holds', '/payables/holds', ShieldAlert, [P['bill.view']], 'Bills'),
      item('Purchase Returns', '/purchasing/returns', Undo2, [P['purchase-return.view']], 'Bills'),
      item('Received Not Billed', '/payables/grni', PackageCheck, [P['ap-accrual.view']], 'Bills'),
      item('Payment Runs', '/payables/payment-runs', Banknote, [P['payment-run.view']], 'Payments'),
      item('Vendor Payments', '/purchasing/payments', Wallet, [P['bill.view']], 'Payments'),
      item(
        'Cash Requirements',
        '/payables/cash-requirements',
        ClipboardList,
        [P['payment-run.view']],
        'Payments',
      ),
      item('AP Aging', '/reports/ap-aging', ClipboardList, [P['reports.view']], 'Control'),
      item('AP Accruals', '/payables/accruals', Layers, [P['ap-accrual.view']], 'Control'),
      item('AP Reconciliation', '/payables/reconciliation', Scale, [P['reports.view']], 'Control'),
      item('Payables Settings', '/payables/settings', Settings2, [P['vendor.view']], 'Control'),
    ],
  },
  {
    title: 'Treasury',
    icon: Vault,
    items: [
      item('Cash Dashboard', '/treasury/dashboard', LayoutDashboard, [P['treasury.view']]),
      item('Cash Position', '/treasury/position', Landmark, [P['treasury.view']], 'Cash'),
      item('Cash Forecast', '/treasury/forecast', BarChart3, [P['treasury.view']], 'Cash'),
      item(
        'Bank Transfers',
        '/treasury/transfers',
        ArrowLeftRight,
        [P['treasury.view']],
        'Movements',
      ),
      item(
        'Payment Files',
        '/treasury/payment-files',
        FileCode2,
        [P['treasury.view']],
        'Movements',
      ),
      item('Petty Cash', '/treasury/petty-cash', Coins, [P['treasury.view']], 'Movements'),
      item('Treasury Settings', '/treasury/settings', Settings2, [P['treasury.view']], 'Control'),
    ],
  },
  {
    title: 'Group',
    icon: Network,
    items: [
      item('Consolidation Groups', '/consolidation/groups', Building2, [P['consolidation.view']]),
      item('Consolidation Runs', '/consolidation/runs', Layers, [P['consolidation.view']]),
      item(
        'Intercompany',
        '/accounting/intercompany',
        GitBranch,
        [P['intercompany.view']],
        'Intercompany',
      ),
      item(
        'Intercompany Reconciliation',
        '/consolidation/intercompany-reconciliation',
        Scale,
        [P['consolidation.view']],
        'Intercompany',
      ),
      item(
        'Quick Consolidated TB',
        '/reports/consolidation',
        ClipboardList,
        [P['consolidation.view']],
        'Reports',
      ),
    ],
  },
  {
    title: 'Operations',
    icon: Boxes,
    items: [
      item('Quotations', '/sales/quotations', FileQuestion, [P['quotation.view']], 'Sales'),
      item('Sales Orders', '/sales/orders', ShoppingCart, [P['sales-order.view']], 'Sales'),
      item(
        'Purchase Requests',
        '/purchasing/requests',
        ClipboardCheck,
        [P['purchase-request.view']],
        'Purchasing',
      ),
      item(
        'Purchase Orders',
        '/purchasing/orders',
        ClipboardList,
        [P['purchase-order.view']],
        'Purchasing',
      ),
      item(
        'Goods Receipts',
        '/purchasing/receipts',
        PackageCheck,
        [P['goods-receipt.view']],
        'Purchasing',
      ),
      item(
        'Purchasing Settings',
        '/purchasing/settings',
        Settings2,
        [P['purchase-order.view']],
        'Purchasing',
      ),
      item('Products', '/inventory/products', Package, [P['product.view']], 'Inventory'),
      item('Warehouses', '/inventory/warehouses', Boxes, [P['inventory.view']], 'Inventory'),
      item('Stock on Hand', '/inventory/stock', Layers, [P['inventory.view']], 'Inventory'),
      item(
        'Adjustments',
        '/inventory/adjustments',
        SlidersHorizontal,
        [P['inventory.view']],
        'Inventory',
      ),
      item('Transfers', '/inventory/transfers', Truck, [P['inventory.view']], 'Inventory'),
      item('Stock Counts', '/inventory/counts', ClipboardCheck, [P['inventory.view']], 'Inventory'),
      item(
        'Inventory Valuation',
        '/inventory/valuation',
        Scale,
        [P['inventory.view']],
        'Inventory',
      ),
      item(
        'Inventory Settings',
        '/inventory/settings',
        Settings2,
        [P['inventory.view']],
        'Inventory',
      ),
    ],
  },
  {
    title: 'Finance',
    icon: Banknote,
    items: [
      item('Bank Accounts', '/banking/accounts', Landmark, [P['bank-account.view']], 'Banking'),
      item(
        'Bank Transactions',
        '/banking/transactions',
        Banknote,
        [P['bank-account.view']],
        'Banking',
      ),
      item(
        'Bank Reconciliation',
        '/banking/reconciliation',
        Scale,
        [P['bank-reconciliation.perform']],
        'Banking',
      ),
      item('Assets', '/fixed-assets/assets', Building2, [P['fixed-asset.view']], 'Fixed Assets'),
      item(
        'Depreciation',
        '/fixed-assets/depreciation',
        BarChart3,
        [P['fixed-asset.view']],
        'Fixed Assets',
      ),
      item(
        'Asset Categories',
        '/fixed-assets/categories',
        Settings2,
        [P['fixed-asset.view']],
        'Fixed Assets',
      ),
      item('Budgets', '/budgeting/budgets', PieChart, [P['budget.view']], 'Budgeting'),
      item('Variance Analysis', '/budgeting/variance', BarChart3, [P['budget.view']], 'Budgeting'),
      item('Dimensions', '/budgeting/dimensions', Layers, [P['dimension.view']], 'Budgeting'),
      item(
        'Expense Claims',
        '/budgeting/expense-claims',
        Receipt,
        [P['expense-claim.view']],
        'Budgeting',
      ),
      item('Tax Codes', '/tax/codes', BadgePercent, [P['tax.view']], 'Tax'),
      item('Tax Transactions', '/tax/transactions', FileText, [P['tax.view']], 'Tax'),
      item('Tax Reports', '/tax/reports', BarChart3, [P['tax.view']], 'Tax'),
    ],
  },
  {
    title: 'Reporting',
    icon: BarChart3,
    items: [
      item('Financial Statements', '/reports/financial-statements', FileText, [P['reports.view']]),
      item('Custom Reports', '/reports/custom', SlidersHorizontal, [P['reports.view']]),
      item('AR Aging', '/reports/ar-aging', ClipboardList, [P['reports.view']]),
      item('AP Aging', '/reports/ap-aging', ClipboardList, [P['reports.view']]),
      item('General Ledger Report', '/reports/general-ledger', BookOpenText, [P['reports.view']]),
    ],
  },
  {
    title: 'AI Assistant',
    icon: Sparkles,
    items: [
      item('Ask', '/ai/assistant', MessageSquareText, [P['ai.view']]),
      item('Document Intake', '/ai/intake', ScanText, [P['ai.view']]),
      item('Anomalies', '/ai/anomalies', Siren, [P['ai.view']]),
      item('Forecast', '/ai/forecast', PieChart, [P['ai.view']]),
    ],
  },
  {
    title: 'Administration',
    icon: Settings2,
    items: [
      item('Users', '/admin/users', Users, [P['user.view']]),
      item('Roles & Permissions', '/admin/roles', ShieldCheck, [P['role.view']]),
      item('Organization', '/admin/organization', Building2, [
        P['organization.view'],
        P['company.view'],
      ]),
      item('Approval Workflows', '/admin/workflows', Workflow, [P['approval.view']]),
      item('Approvals', '/admin/approvals', Inbox, [P['approval.view']]),
      item('Operations', '/admin/operations', Activity, [P['operations.view']]),
      item('Delegated Authority', '/admin/delegations', UserCheck, [P['delegation.view']]),
      item('Integrations', '/admin/integrations', Cable, [P['integration.view']]),
      item('API Keys', '/admin/api-keys', KeyRound, [P['api-key.view']]),
      item('Webhooks', '/admin/webhooks', Webhook, [P['webhook.view']]),
      item('Integration Logs', '/admin/integration-logs', ScrollText, [P['integration.view']]),
      item('Notifications', '/admin/notifications', Bell, [P['notification.view']]),
      item('Document Numbering', '/admin/numbering', Hash, [P['numbering.view']]),
      item('Data Imports', '/admin/imports', FileUp, [P['import.view']]),
      item('Audit Logs', '/admin/audit-logs', ClipboardList, [P['audit.view']]),
    ],
  },
];

export function findNavItem(pathname: string): { section: NavSection; item: NavItem } | undefined {
  for (const section of NAVIGATION) {
    const item = section.items.find(
      (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
    );
    if (item) return { section, item };
  }
  return undefined;
}

/** Items of a section grouped by their optional `group`, preserving order. */
export function groupItems(items: NavItem[]): Array<{ group?: string; items: NavItem[] }> {
  const out: Array<{ group?: string; items: NavItem[] }> = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (last && last.group === it.group) last.items.push(it);
    else out.push({ group: it.group, items: [it] });
  }
  return out;
}

/**
 * Global keyboard shortcuts (documented in docs/design-system/keyboard-shortcuts.md).
 * Browser-native shortcuts are never overridden except Ctrl+K / Ctrl+/ which
 * are reserved for the palette and search.
 */
export const SHORTCUTS = [
  { keys: ['Ctrl', 'K'], description: 'Command palette' },
  { keys: ['Ctrl', '/'], description: 'Search records' },
  { keys: ['Ctrl', 'B'], description: 'Toggle sidebar' },
  { keys: ['?'], description: 'Keyboard shortcuts' },
  { keys: ['Esc'], description: 'Close dialog / palette' },
  { keys: ['G', 'D'], description: 'Go to dashboard' },
  { keys: ['G', 'J'], description: 'Go to journal entries' },
  { keys: ['G', 'L'], description: 'Go to general ledger' },
  { keys: ['G', 'I'], description: 'Go to invoices' },
  { keys: ['G', 'B'], description: 'Go to bills' },
  { keys: ['G', 'A'], description: 'Go to approvals' },
] as const;

export const GO_TO: Record<string, string> = {
  d: '/dashboard',
  j: '/accounting/journal-entries',
  l: '/accounting/general-ledger',
  i: '/sales/invoices',
  b: '/purchasing/bills',
  a: '/admin/approvals',
};
