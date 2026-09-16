import { test } from '@playwright/test';
import { login } from './helpers';

/**
 * Visual QA capture (not an assertion suite): writes screenshots of the key
 * screens in both themes to `test-results/visual/`. Run with
 * `npx playwright test e2e/visual-qa.spec.ts`.
 */
const SCREENS: Array<[string, string]> = [
  ['dashboard', '/dashboard'],
  ['general-ledger', '/accounting/general-ledger'],
  ['journal-entries', '/accounting/journal-entries'],
  ['journal-new', '/accounting/journal-entries/new'],
  ['chart-of-accounts', '/accounting/chart-of-accounts'],
  ['trial-balance', '/accounting/trial-balance'],
  ['invoices', '/sales/invoices'],
  ['payments', '/sales/payments'],
  ['purchase-orders', '/purchasing/orders'],
  ['inventory', '/inventory/stock'],
  ['bank-reconciliation', '/banking/reconciliation'],
  ['reports', '/reports/financial-statements'],
  ['integrations', '/admin/integrations'],
  ['delegations', '/admin/delegations'],
  ['approvals', '/admin/approvals'],
  ['organization', '/admin/organization'],
];

for (const theme of ['dark', 'light'] as const) {
  test(`capture ${theme}`, async ({ page }) => {
    test.setTimeout(240_000);
    await login(page);
    await page.evaluate((t) => localStorage.setItem('accounting.theme', t), theme);
    for (const [name, path] of SCREENS) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(800);
      await page.screenshot({ path: `test-results/visual/${theme}-${name}.png`, fullPage: false });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: `test-results/visual/${theme}-mobile-dashboard.png` });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/visual/${theme}-mobile-nav.png` });
  });
}
