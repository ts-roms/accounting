import { describe, expect, it } from 'vitest';
import { GO_TO, NAVIGATION, SHORTCUTS, findNavItem, groupItems } from './navigation';

describe('navigation', () => {
  it('resolves a pathname to its section and item', () => {
    const match = findNavItem('/admin/users');
    expect(match?.section.title).toBe('Administration');
    expect(match?.item.title).toBe('Users');
  });

  it('groups items by their optional sub-heading, preserving order', () => {
    const ops = NAVIGATION.find((s) => s.title === 'Operations')!;
    const groups = groupItems(ops.items).map((g) => g.group);
    expect(groups).toEqual(['Sales', 'Purchasing', 'Inventory']);
    expect(groupItems([{ title: 'A', href: '/a' }])).toEqual([
      { group: undefined, items: [{ title: 'A', href: '/a' }] },
    ]);
  });

  it('every go-to shortcut targets a navigable page', () => {
    const hrefs = new Set(NAVIGATION.flatMap((s) => s.items.map((i) => i.href)));
    for (const href of Object.values(GO_TO)) expect(hrefs.has(href), href).toBe(true);
    expect(SHORTCUTS.some((s) => s.keys.join('+') === 'Ctrl+K')).toBe(true);
  });

  it('matches nested paths and ignores unknown ones', () => {
    expect(findNavItem('/admin/users/123')?.item.href).toBe('/admin/users');
    expect(findNavItem('/nope')).toBeUndefined();
  });

  it('marks every unimplemented module with a roadmap phase', () => {
    const implemented = new Set([
      '/dashboard',
      '/admin/users',
      '/admin/roles',
      '/admin/audit-logs',
      '/admin/numbering',
      '/admin/imports',
      '/admin/organization',
      ...[
        'chart-of-accounts',
        'journal-entries',
        'general-ledger',
        'trial-balance',
        'period-closing',
        'opening-balances',
        'control-center',
        'journal-control',
        'suspense',
      ].map((p) => `/accounting/${p}`),
      '/reports/financial-statements',
      '/reports/custom',
      '/reports/general-ledger',
      '/reports/ar-aging',
      '/reports/ap-aging',
      ...['customers', 'invoices', 'payments', 'quotations', 'orders', 'returns'].map(
        (p) => `/sales/${p}`,
      ),
      ...[
        'vendors',
        'bills',
        'payments',
        'requests',
        'orders',
        'receipts',
        'returns',
        'settings',
      ].map((p) => `/purchasing/${p}`),
      ...[
        'products',
        'warehouses',
        'stock',
        'adjustments',
        'transfers',
        'counts',
        'valuation',
        'settings',
      ].map((p) => `/inventory/${p}`),
      ...['accounts', 'transactions', 'reconciliation'].map((p) => `/banking/${p}`),
      ...['assets', 'depreciation', 'categories'].map((p) => `/fixed-assets/${p}`),
      ...['budgets', 'variance', 'dimensions', 'expense-claims'].map((p) => `/budgeting/${p}`),
      ...['codes', 'transactions', 'reports'].map((p) => `/tax/${p}`),
      ...[
        'exchange-rates',
        'fx-revaluation',
        'intercompany',
        'integrity',
        'reconciliation',
        'financial-close',
        'suspense',
        'recurring-journals',
        'prepayments',
        'posting-rules',
      ].map((p) => `/accounting/${p}`),
      '/reports/consolidation',
      '/admin/workflows',
      '/admin/approvals',
      ...[
        'delegations',
        'integrations',
        'api-keys',
        'webhooks',
        'integration-logs',
        'notifications',
      ].map((p) => `/admin/${p}`),
      ...['assistant', 'intake', 'anomalies', 'forecast'].map((p) => `/ai/${p}`),
      ...[
        'dashboard',
        'deliveries',
        'credit-notes',
        'debit-notes',
        'refunds',
        'statements',
        'collections',
        'disputes',
        'write-offs',
        'reconciliation',
        'settings',
      ].map((p) => `/receivables/${p}`),
      ...[
        'dashboard',
        'statements',
        'holds',
        'grni',
        'payment-runs',
        'cash-requirements',
        'accruals',
        'reconciliation',
        'settings',
      ].map((p) => `/payables/${p}`),
    ]);
    for (const section of NAVIGATION) {
      for (const item of section.items) {
        if (!implemented.has(item.href)) expect(item.phase, item.href).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
