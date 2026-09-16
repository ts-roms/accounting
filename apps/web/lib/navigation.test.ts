import { describe, expect, it } from 'vitest';
import { NAVIGATION, findNavItem } from './navigation';

describe('navigation', () => {
  it('resolves a pathname to its section and item', () => {
    const match = findNavItem('/admin/users');
    expect(match?.section.title).toBe('Administration');
    expect(match?.item.title).toBe('Users');
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
      '/admin/organization',
      ...[
        'chart-of-accounts',
        'journal-entries',
        'general-ledger',
        'trial-balance',
        'period-closing',
      ].map((p) => `/accounting/${p}`),
      '/reports/financial-statements',
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
    ]);
    for (const section of NAVIGATION) {
      for (const item of section.items) {
        if (!implemented.has(item.href)) expect(item.phase, item.href).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
