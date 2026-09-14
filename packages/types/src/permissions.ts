/**
 * Permission catalog - the single source of truth for fine-grained permissions.
 *
 * Keys follow `<resource>.<action>`. Adding a permission here (and re-running the
 * seed) makes it available for assignment; the backend never hard-codes role names
 * in business logic, only permission keys.
 */
export const PERMISSION_MODULES = [
  'ADMINISTRATION',
  'ACCOUNTING',
  'SALES',
  'PURCHASING',
  'INVENTORY',
  'BANKING',
  'FIXED_ASSETS',
  'BUDGETING',
  'TAX',
  'REPORTING',
  'AUDIT',
  'AI',
] as const;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export interface PermissionDefinition {
  key: string;
  module: PermissionModule;
  description: string;
}

const define = <const K extends string>(
  key: K,
  module: PermissionModule,
  description: string,
): PermissionDefinition & { key: K } => ({ key, module, description });

export const PERMISSION_DEFINITIONS = [
  // Administration
  define('organization.view', 'ADMINISTRATION', 'View organization settings'),
  define('organization.manage', 'ADMINISTRATION', 'Update organization settings'),
  define('company.view', 'ADMINISTRATION', 'View companies'),
  define('company.manage', 'ADMINISTRATION', 'Create and update companies'),
  define('branch.view', 'ADMINISTRATION', 'View branches'),
  define('branch.manage', 'ADMINISTRATION', 'Create and update branches'),
  define('user.view', 'ADMINISTRATION', 'View users'),
  define('user.create', 'ADMINISTRATION', 'Create users'),
  define('user.update', 'ADMINISTRATION', 'Update users'),
  define('user.deactivate', 'ADMINISTRATION', 'Deactivate or reactivate users'),
  define('role.view', 'ADMINISTRATION', 'View roles and permissions'),
  define('role.manage', 'ADMINISTRATION', 'Create and update roles and their permissions'),
  define('role.assign', 'ADMINISTRATION', 'Assign roles to users'),
  define('sod.manage', 'ADMINISTRATION', 'Configure segregation-of-duties policies'),

  // Accounting (Phase 2 - declared now so roles can be pre-seeded)
  define('account.view', 'ACCOUNTING', 'View chart of accounts'),
  define('account.manage', 'ACCOUNTING', 'Create and update accounts'),
  define('journal.view', 'ACCOUNTING', 'View journal entries'),
  define('journal.create', 'ACCOUNTING', 'Create draft journal entries'),
  define('journal.submit', 'ACCOUNTING', 'Submit journal entries for approval'),
  define('journal.approve', 'ACCOUNTING', 'Approve submitted journal entries'),
  define('journal.post', 'ACCOUNTING', 'Post approved journal entries to the ledger'),
  define('journal.reverse', 'ACCOUNTING', 'Reverse posted journal entries'),
  define('period.view', 'ACCOUNTING', 'View fiscal years and periods'),
  define('period.manage', 'ACCOUNTING', 'Create fiscal years and periods'),
  define('period.close', 'ACCOUNTING', 'Close fiscal periods'),
  define('period.reopen', 'ACCOUNTING', 'Reopen closed fiscal periods'),

  // Sales / AR
  define('customer.view', 'SALES', 'View customers'),
  define('customer.manage', 'SALES', 'Create and update customers'),
  define('invoice.view', 'SALES', 'View invoices'),
  define('invoice.create', 'SALES', 'Create invoices'),
  define('invoice.approve', 'SALES', 'Approve invoices'),
  define('invoice.post', 'SALES', 'Post invoices to the ledger'),
  define('invoice.void', 'SALES', 'Void invoices'),
  define('customer-payment.create', 'SALES', 'Record customer payments'),
  define('customer-payment.post', 'SALES', 'Post customer payments'),
  define('quotation.view', 'SALES', 'View quotations'),
  define('quotation.create', 'SALES', 'Create, send and convert quotations'),
  define('sales-order.view', 'SALES', 'View sales orders'),
  define('sales-order.create', 'SALES', 'Create sales orders and invoice them'),
  define('sales-order.approve', 'SALES', 'Approve sales orders'),
  define('sales-return.view', 'SALES', 'View sales returns'),
  define('sales-return.create', 'SALES', 'Record sales returns'),
  define('sales-return.approve', 'SALES', 'Approve sales returns and issue credit notes'),

  // Purchasing / AP
  define('vendor.view', 'PURCHASING', 'View vendors'),
  define('vendor.manage', 'PURCHASING', 'Create and update vendors'),
  define('bill.view', 'PURCHASING', 'View vendor bills'),
  define('bill.create', 'PURCHASING', 'Create vendor bills'),
  define('bill.approve', 'PURCHASING', 'Approve vendor bills'),
  define('bill.post', 'PURCHASING', 'Post vendor bills to the ledger'),
  define('bill.void', 'PURCHASING', 'Void vendor bills'),
  define('vendor-payment.create', 'PURCHASING', 'Record vendor payments'),
  define('vendor-payment.approve', 'PURCHASING', 'Approve vendor payments'),
  define('vendor-payment.post', 'PURCHASING', 'Post vendor payments'),
  define('purchase-request.view', 'PURCHASING', 'View purchase requests'),
  define('purchase-request.create', 'PURCHASING', 'Create and submit purchase requests'),
  define('purchase-request.approve', 'PURCHASING', 'Approve or reject purchase requests'),
  define('purchase-order.view', 'PURCHASING', 'View purchase orders'),
  define('purchase-order.create', 'PURCHASING', 'Create purchase orders and bill them'),
  define('purchase-order.approve', 'PURCHASING', 'Approve purchase orders'),
  define('goods-receipt.view', 'PURCHASING', 'View goods receipts'),
  define('goods-receipt.create', 'PURCHASING', 'Record and confirm goods receipts'),
  define('purchase-return.view', 'PURCHASING', 'View purchase returns'),
  define('purchase-return.create', 'PURCHASING', 'Record purchase returns'),
  define(
    'purchase-return.approve',
    'PURCHASING',
    'Approve purchase returns and issue vendor credit notes',
  ),
  define('bill.match-review', 'PURCHASING', 'Review three-way match exceptions on vendor bills'),
  define(
    'purchasing-settings.manage',
    'PURCHASING',
    'Configure matching tolerances and receiving rules',
  ),

  // Inventory
  define('product.view', 'INVENTORY', 'View products'),
  define('product.manage', 'INVENTORY', 'Create and update products'),
  define('inventory.view', 'INVENTORY', 'View stock levels and movements'),
  define('inventory.adjust', 'INVENTORY', 'Record stock adjustments, transfers and counts'),
  define(
    'inventory.post',
    'INVENTORY',
    'Post stock documents (moves stock and posts to the ledger)',
  ),
  define('warehouse.manage', 'INVENTORY', 'Create and update warehouses and locations'),
  define('inventory-settings.manage', 'INVENTORY', 'Configure costing defaults and stock rules'),

  // Banking
  define('bank-account.view', 'BANKING', 'View bank accounts, transactions and statements'),
  define('bank-account.manage', 'BANKING', 'Manage bank accounts'),
  define('bank-transaction.create', 'BANKING', 'Record deposits, withdrawals, transfers, fees'),
  define('bank-transaction.post', 'BANKING', 'Post and void bank transactions'),
  define('bank-statement.import', 'BANKING', 'Import bank statements'),
  define('bank-reconciliation.perform', 'BANKING', 'Match statement lines and complete reconciliations'),

  // Fixed assets
  define('fixed-asset.view', 'FIXED_ASSETS', 'View fixed assets and depreciation'),
  define('fixed-asset.manage', 'FIXED_ASSETS', 'Register and edit fixed assets and categories'),
  define('fixed-asset.post', 'FIXED_ASSETS', 'Capitalise, impair, revalue and dispose of assets'),
  define('depreciation.run', 'FIXED_ASSETS', 'Create and post depreciation runs'),

  // Budgeting & cost accounting
  define('budget.view', 'BUDGETING', 'View budgets and variance reports'),
  define('budget.manage', 'BUDGETING', 'Create and update budgets and versions'),
  define('budget.approve', 'BUDGETING', 'Approve budget versions'),
  define('dimension.view', 'BUDGETING', 'View departments, cost centers and projects'),
  define('dimension.manage', 'BUDGETING', 'Manage departments, cost centers and projects'),
  define('expense-claim.view', 'BUDGETING', 'View expense claims'),
  define('expense-claim.create', 'BUDGETING', 'Create and submit expense claims'),
  define('expense-claim.approve', 'BUDGETING', 'Approve or reject expense claims'),
  define('expense-claim.post', 'BUDGETING', 'Post and pay expense claims'),

  // Enterprise (Phase 8)
  define('exchange-rate.view', 'ACCOUNTING', 'View exchange rates'),
  define('exchange-rate.manage', 'ACCOUNTING', 'Maintain exchange rates'),
  define('fx.revalue', 'ACCOUNTING', 'Run and reverse foreign-currency revaluations'),
  define('consolidation.view', 'REPORTING', 'View consolidated group reports'),
  define('intercompany.view', 'ACCOUNTING', 'View intercompany transactions'),
  define('intercompany.post', 'ACCOUNTING', 'Create and post intercompany transactions'),
  define('workflow.manage', 'ADMINISTRATION', 'Configure approval workflows'),
  define('approval.view', 'ADMINISTRATION', 'View approval requests'),
  define('approval.decide', 'ADMINISTRATION', 'Approve or reject approval requests'),
  define('attachment.view', 'ADMINISTRATION', 'View and download attachments'),
  define('attachment.manage', 'ADMINISTRATION', 'Upload and remove attachments'),

  // Tax
  define('tax.view', 'TAX', 'View tax codes, transactions and reports'),
  define('tax.manage', 'TAX', 'Manage tax codes and rates'),

  // Reporting & audit
  define('reports.view', 'REPORTING', 'View financial reports'),
  define('reports.export', 'REPORTING', 'Export reports'),
  define('audit.view', 'AUDIT', 'View the audit trail'),

  // AI assistance (advisory only - nothing here posts)
  define('ai.view', 'AI', 'View AI intake, anomaly flags, forecasts and conversations'),
  define('ai.use', 'AI', 'Upload documents for extraction, ask the assistant, run scans'),
  define('ai.review', 'AI', 'Accept or dismiss AI drafts and anomaly flags'),
] as const;

export type PermissionKey = (typeof PERMISSION_DEFINITIONS)[number]['key'];

export const PERMISSION_KEYS = PERMISSION_DEFINITIONS.map((p) => p.key) as readonly PermissionKey[];

/** Typed helper so callers get autocomplete and compile-time checking. */
export const P = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, k])) as {
  readonly [K in PermissionKey]: K;
};

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}
