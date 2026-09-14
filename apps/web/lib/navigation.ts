import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  BadgePercent,
  Banknote,
  BarChart3,
  BookOpenText,
  Boxes,
  Building2,
  ClipboardCheck,
  Coins,
  GitBranch,
  Inbox,
  Workflow,
  ClipboardList,
  FileText,
  FileQuestion,
  Landmark,
  Layers,
  LayoutDashboard,
  MessageSquareText,
  Package,
  PackageCheck,
  PieChart,
  Receipt,
  Scale,
  ScanText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  ShoppingCart,
  Siren,
  Sparkles,
  Truck,
  Undo2,
  Users,
  Wallet,
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
}

export interface NavSection {
  title: string;
  icon: LucideIcon;
  items: NavItem[];
}

/**
 * Application navigation. Mirrors the module map of the platform; items whose
 * `phase` is set render a roadmap placeholder until that phase ships. The
 * backend enforces permissions - this list only shapes the menu.
 */
export const NAVIGATION: NavSection[] = [
  {
    title: 'Overview',
    icon: LayoutDashboard,
    items: [{ title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard }],
  },
  {
    title: 'Accounting',
    icon: BookOpenText,
    items: [
      {
        title: 'Chart of Accounts',
        href: '/accounting/chart-of-accounts',
        icon: BookOpenText,
        permissions: [P['account.view']],
      },
      {
        title: 'Journal Entries',
        href: '/accounting/journal-entries',
        icon: FileText,
        permissions: [P['journal.view']],
      },
      {
        title: 'General Ledger',
        href: '/accounting/general-ledger',
        icon: ClipboardList,
        permissions: [P['journal.view']],
      },
      {
        title: 'Trial Balance',
        href: '/accounting/trial-balance',
        icon: Scale,
        permissions: [P['reports.view']],
      },
      {
        title: 'Period Closing',
        href: '/accounting/period-closing',
        icon: Landmark,
        permissions: [P['period.view']],
      },
      {
        title: 'Exchange Rates',
        href: '/accounting/exchange-rates',
        icon: Coins,
        permissions: [P['exchange-rate.view']],
      },
      {
        title: 'FX Revaluation',
        href: '/accounting/fx-revaluation',
        icon: Scale,
        permissions: [P['exchange-rate.view']],
      },
      {
        title: 'Intercompany',
        href: '/accounting/intercompany',
        icon: GitBranch,
        permissions: [P['intercompany.view']],
      },
      {
        title: 'Control Center',
        href: '/accounting/control-center',
        icon: LayoutDashboard,
        permissions: [P['controls.view']],
      },
      {
        title: 'Financial Close',
        href: '/accounting/financial-close',
        icon: ClipboardCheck,
        permissions: [P['close.view']],
      },
      {
        title: 'Reconciliation Center',
        href: '/accounting/reconciliation',
        icon: Scale,
        permissions: [P['reconciliation.view']],
      },
      {
        title: 'Integrity',
        href: '/accounting/integrity',
        icon: ShieldCheck,
        permissions: [P['integrity.check']],
      },
      {
        title: 'Suspense Accounts',
        href: '/accounting/suspense',
        icon: AlertTriangle,
        permissions: [P['controls.view']],
      },
    ],
  },
  {
    title: 'Sales',
    icon: Receipt,
    items: [
      {
        title: 'Customers',
        href: '/sales/customers',
        icon: Users,
        permissions: [P['customer.view']],
      },
      {
        title: 'Quotations',
        href: '/sales/quotations',
        icon: FileQuestion,
        permissions: [P['quotation.view']],
      },
      {
        title: 'Sales Orders',
        href: '/sales/orders',
        icon: ShoppingCart,
        permissions: [P['sales-order.view']],
      },
      {
        title: 'Invoices',
        href: '/sales/invoices',
        icon: Receipt,
        permissions: [P['invoice.view']],
      },
      {
        title: 'Payments',
        href: '/sales/payments',
        icon: Wallet,
        permissions: [P['invoice.view']],
      },
      {
        title: 'Sales Returns',
        href: '/sales/returns',
        icon: Undo2,
        permissions: [P['sales-return.view']],
      },
    ],
  },
  {
    title: 'Purchasing',
    icon: Truck,
    items: [
      {
        title: 'Vendors',
        href: '/purchasing/vendors',
        icon: Building2,
        permissions: [P['vendor.view']],
      },
      {
        title: 'Purchase Requests',
        href: '/purchasing/requests',
        icon: ClipboardCheck,
        permissions: [P['purchase-request.view']],
      },
      {
        title: 'Purchase Orders',
        href: '/purchasing/orders',
        icon: ClipboardList,
        permissions: [P['purchase-order.view']],
      },
      {
        title: 'Goods Receipts',
        href: '/purchasing/receipts',
        icon: PackageCheck,
        permissions: [P['goods-receipt.view']],
      },
      {
        title: 'Bills',
        href: '/purchasing/bills',
        icon: FileText,
        permissions: [P['bill.view']],
      },
      {
        title: 'Payments',
        href: '/purchasing/payments',
        icon: Wallet,
        permissions: [P['bill.view']],
      },
      {
        title: 'Purchase Returns',
        href: '/purchasing/returns',
        icon: Undo2,
        permissions: [P['purchase-return.view']],
      },
      {
        title: 'Purchasing Settings',
        href: '/purchasing/settings',
        icon: Settings2,
        permissions: [P['purchase-order.view']],
      },
    ],
  },
  {
    title: 'Inventory',
    icon: Boxes,
    items: [
      {
        title: 'Products',
        href: '/inventory/products',
        icon: Package,
        permissions: [P['product.view']],
      },
      {
        title: 'Warehouses',
        href: '/inventory/warehouses',
        icon: Boxes,
        permissions: [P['inventory.view']],
      },
      {
        title: 'Stock on Hand',
        href: '/inventory/stock',
        icon: Layers,
        permissions: [P['inventory.view']],
      },
      {
        title: 'Adjustments',
        href: '/inventory/adjustments',
        icon: SlidersHorizontal,
        permissions: [P['inventory.view']],
      },
      {
        title: 'Transfers',
        href: '/inventory/transfers',
        icon: Truck,
        permissions: [P['inventory.view']],
      },
      {
        title: 'Stock Counts',
        href: '/inventory/counts',
        icon: ClipboardCheck,
        permissions: [P['inventory.view']],
      },
      {
        title: 'Inventory Valuation',
        href: '/inventory/valuation',
        icon: Scale,
        permissions: [P['inventory.view']],
      },
      {
        title: 'Inventory Settings',
        href: '/inventory/settings',
        icon: Settings2,
        permissions: [P['inventory.view']],
      },
    ],
  },
  {
    title: 'Banking',
    icon: Banknote,
    items: [
      {
        title: 'Bank Accounts',
        href: '/banking/accounts',
        icon: Landmark,
        permissions: [P['bank-account.view']],
      },
      {
        title: 'Transactions',
        href: '/banking/transactions',
        icon: Banknote,
        permissions: [P['bank-account.view']],
      },
      {
        title: 'Reconciliation',
        href: '/banking/reconciliation',
        icon: Scale,
        permissions: [P['bank-reconciliation.perform']],
      },
    ],
  },
  {
    title: 'Fixed Assets',
    icon: Building2,
    items: [
      {
        title: 'Assets',
        href: '/fixed-assets/assets',
        icon: Building2,
        permissions: [P['fixed-asset.view']],
      },
      {
        title: 'Depreciation',
        href: '/fixed-assets/depreciation',
        icon: BarChart3,
        permissions: [P['fixed-asset.view']],
      },
      {
        title: 'Categories',
        href: '/fixed-assets/categories',
        icon: Settings2,
        permissions: [P['fixed-asset.view']],
      },
    ],
  },
  {
    title: 'Budgeting',
    icon: PieChart,
    items: [
      {
        title: 'Budgets',
        href: '/budgeting/budgets',
        icon: PieChart,
        permissions: [P['budget.view']],
      },
      {
        title: 'Variance Analysis',
        href: '/budgeting/variance',
        icon: BarChart3,
        permissions: [P['budget.view']],
      },
      {
        title: 'Dimensions',
        href: '/budgeting/dimensions',
        icon: Layers,
        permissions: [P['dimension.view']],
      },
      {
        title: 'Expense Claims',
        href: '/budgeting/expense-claims',
        icon: Receipt,
        permissions: [P['expense-claim.view']],
      },
    ],
  },
  {
    title: 'Tax',
    icon: BadgePercent,
    items: [
      {
        title: 'Tax Codes',
        href: '/tax/codes',
        icon: BadgePercent,
        permissions: [P['tax.view']],
      },
      {
        title: 'Tax Transactions',
        href: '/tax/transactions',
        icon: FileText,
        permissions: [P['tax.view']],
      },
      {
        title: 'Tax Reports',
        href: '/tax/reports',
        icon: BarChart3,
        permissions: [P['tax.view']],
      },
    ],
  },
  {
    title: 'Reports',
    icon: BarChart3,
    items: [
      {
        title: 'Financial Statements',
        href: '/reports/financial-statements',
        icon: FileText,
        permissions: [P['reports.view']],
      },
      {
        title: 'AR Aging',
        href: '/reports/ar-aging',
        icon: ClipboardList,
        permissions: [P['reports.view']],
      },
      {
        title: 'AP Aging',
        href: '/reports/ap-aging',
        icon: ClipboardList,
        permissions: [P['reports.view']],
      },
      {
        title: 'General Ledger',
        href: '/reports/general-ledger',
        icon: BookOpenText,
        permissions: [P['reports.view']],
      },
      {
        title: 'Consolidation',
        href: '/reports/consolidation',
        icon: Building2,
        permissions: [P['consolidation.view']],
      },
    ],
  },
  {
    title: 'AI Assistant',
    icon: Sparkles,
    items: [
      { title: 'Ask', href: '/ai/assistant', icon: MessageSquareText, permissions: [P['ai.view']] },
      { title: 'Document Intake', href: '/ai/intake', icon: ScanText, permissions: [P['ai.view']] },
      { title: 'Anomalies', href: '/ai/anomalies', icon: Siren, permissions: [P['ai.view']] },
      { title: 'Forecast', href: '/ai/forecast', icon: PieChart, permissions: [P['ai.view']] },
    ],
  },
  {
    title: 'Administration',
    icon: Settings2,
    items: [
      { title: 'Users', href: '/admin/users', icon: Users, permissions: [P['user.view']] },
      {
        title: 'Roles & Permissions',
        href: '/admin/roles',
        icon: ShieldCheck,
        permissions: [P['role.view']],
      },
      {
        title: 'Audit Logs',
        href: '/admin/audit-logs',
        icon: ClipboardList,
        permissions: [P['audit.view']],
      },
      {
        title: 'Organization',
        href: '/admin/organization',
        icon: Building2,
        permissions: [P['organization.view'], P['company.view']],
      },
      {
        title: 'Approval Workflows',
        href: '/admin/workflows',
        icon: Workflow,
        permissions: [P['approval.view']],
      },
      {
        title: 'Approvals',
        href: '/admin/approvals',
        icon: Inbox,
        permissions: [P['approval.view']],
      },
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
