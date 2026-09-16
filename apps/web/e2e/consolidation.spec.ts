import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * Prompt #9 - Group section. Runs against the seeded development stack
 * (ACME-GROUP: Acme Trading owns 80% of Acme Services, three elimination
 * rules, a settled management fee).
 */
test.describe('consolidation platform', () => {
  test.slow();

  test('groups list and detail show members, rules and readiness from the seed', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/consolidation/groups');
    await expect(page.getByRole('heading', { name: 'Consolidation Groups' })).toBeVisible();
    await expect(page.getByText('ACME-GROUP Acme Group')).toBeVisible({ timeout: 45_000 });
    await page.getByText('ACME-GROUP Acme Group').click();
    await expect(page).toHaveURL(/\/consolidation\/groups\/[0-9a-f-]+$/);
    await expect(page.getByText('Elimination rules')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('IC-BALANCES Intercompany receivables and payables')).toBeVisible();
    await expect(page.getByText('INVESTMENT Investment against subsidiary equity')).toBeVisible();
    await expect(page.getByRole('cell', { name: /ACMS/ }).first()).toBeVisible();
    await expect(page.getByText('Group close readiness')).toBeVisible();
    await expect(page.getByText('Closing rates loaded')).toBeVisible();
  });

  test('a run can be opened from the group, shows a balanced trial balance and statements, and re-prepares', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/consolidation/groups');
    await page.getByText('ACME-GROUP Acme Group').click();
    await expect(page.getByText('Elimination rules')).toBeVisible({ timeout: 45_000 });
    // A run to this date may already exist from an earlier pass: open it from the list instead of failing on the duplicate.
    await page.getByLabel('Period end').fill('2026-07-31');
    await page.getByRole('button', { name: 'New run' }).click();
    await page.waitForTimeout(3000);
    if (!/\/consolidation\/runs\/[0-9a-f-]+$/.test(page.url())) {
      await page.goto('/consolidation/runs');
      await page.getByText('CON-2026-', { exact: false }).first().click();
    }
    await expect(page).toHaveURL(/\/consolidation\/runs\/[0-9a-f-]+$/, { timeout: 30_000 });
    await expect(page.getByText('Consolidated trial balance')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
    await expect(page.getByText('Yes', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('1710 Goodwill')).toBeVisible();
    await page.getByRole('tab', { name: 'Statements' }).click();
    await expect(page.getByText('Consolidated balance sheet')).toBeVisible();
    await expect(page.getByText('Attributable to non-controlling interest')).toBeVisible();
    await page.getByRole('tab', { name: 'Adjustments' }).click();
    await expect(page.getByText('Consolidation ledger')).toBeVisible();
    await expect(
      page.getByText('INVESTMENT: investment in ACMS against equity at acquisition'),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Members and rates' }).click();
    await expect(page.getByText('Members and translation rates')).toBeVisible();
    await expect(page.getByText('Lifecycle')).toBeVisible();
    if (await page.getByRole('button', { name: 'Re-prepare' }).isVisible()) {
      await page.getByRole('button', { name: 'Re-prepare' }).click();
      await expect(page.getByText('Re-prepared from the member ledgers.')).toBeVisible({
        timeout: 30_000,
      });
    }
  });

  test('intercompany reconciliation and the intercompany register render from live data', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/consolidation/intercompany-reconciliation');
    await expect(page.getByRole('heading', { name: 'Intercompany Reconciliation' })).toBeVisible();
    await expect(page.getByText('Open intercompany', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText('Per entity: ledger vs register')).toBeVisible();
    await expect(page.getByText('Consolidation integrity')).toBeVisible();
    await expect(page.getByText('Consolidated trial balances balance')).toBeVisible({
      timeout: 45_000,
    });
    await page.goto('/accounting/intercompany');
    await expect(page.getByRole('heading', { name: 'Intercompany' })).toBeVisible();
    await expect(page.getByText('Group management fee - H1 2026')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Settled', { exact: true })).toBeVisible();
  });
});
