import { expect, test } from '@playwright/test';
import { login } from './helpers';

/** Hardening H9: consolidation groups, chart mappings, the group report, readiness and runs. */
test.describe('consolidation groups', () => {
  test.slow();

  test('a group is created, auto-mapped and consolidated; readiness lists the checks and a run is stored', async ({
    page,
  }) => {
    await login(page);
    const stamp = Date.now().toString().slice(-6);
    await page.goto('/admin/consolidation-groups');
    await page.getByTestId('group-create').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('group-code').fill(`PW-${stamp}`);
    await dialog.getByTestId('group-name').fill(`Playwright group ${stamp}`);
    await dialog.getByTestId('group-member-toggle').first().check();
    await dialog.getByTestId('group-member-pct').first().fill('75');
    await dialog.getByTestId('group-save').click();
    await expect(dialog).toHaveCount(0);
    const row = page.locator(`[data-testid="group-row"][data-code="PW-${stamp}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('75% full');
    await row.click();
    await expect(page.getByTestId('mapping-summary')).toContainText(/unmapped/);
    await page.getByTestId('mapping-auto').click();
    await expect(page.getByTestId('mapping-summary')).toHaveText(
      'Every postable account is mapped.',
    );
    await expect(page.locator('[data-testid="mapping-row"][data-mapped="no"]')).toHaveCount(0);

    await page.goto('/reports/consolidation');
    await page.getByTestId('consol-group').click();
    await page.getByRole('option', { name: new RegExp(`PW-${stamp}`) }).click();
    await expect(page.getByTestId('consol-status')).toContainText('Balanced');
    await expect(page.getByTestId('consol-status')).toContainText('0 unmapped');
    await expect(page.getByTestId('consol-row').first()).toBeVisible();
    await expect(
      page.getByTestId('consol-rows').locator('th', { hasText: 'Consolidated' }),
    ).toBeVisible();

    await page.getByTestId('consol-tab-readiness').click();
    await expect(page.locator('[data-testid="consol-check"][data-key="MEMBERS"]')).toHaveAttribute(
      'data-status',
      'PASS',
    );
    await expect(page.locator('[data-testid="consol-check"][data-key="MAPPINGS"]')).toHaveAttribute(
      'data-status',
      'PASS',
    );
    await expect(page.locator('[data-testid="consol-check"][data-key="BALANCED"]')).toHaveAttribute(
      'data-status',
      'PASS',
    );
    await expect(page.getByTestId('consol-ready')).toBeVisible();

    await page.getByTestId('consol-tab-runs').click();
    await page.getByTestId('consol-run-create').click();
    await expect(page.getByText(/Run stored for/)).toBeVisible();
    const run = page.getByTestId('consol-run').first();
    await expect(run).toBeVisible();
    await expect(run).toHaveAttribute('data-status', 'DRAFT');
    if ((await run.getByTestId('consol-run-finalize').isEnabled()) === true) {
      await run.getByTestId('consol-run-finalize').click();
      await expect(page.getByText('Consolidation finalised')).toBeVisible();
      await expect(page.getByTestId('consol-run').first()).toHaveAttribute('data-status', 'FINAL');
    }
  });

  test('a balanced group adjustment is booked from the console and shows in the adjustments list', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/reports/consolidation');
    await page.getByTestId('consol-tab-adjustments').click();
    await page.getByTestId('consol-adj-add').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('consol-adj-desc').fill('Playwright reclassification');
    const accounts = dialog.getByTestId('consol-adj-account');
    await accounts.nth(0).click();
    await page.getByRole('option', { name: /^3100/ }).click();
    await dialog.getByTestId('consol-adj-debit').nth(0).fill('250');
    await accounts.nth(1).click();
    await page.getByRole('option', { name: /^1130/ }).click();
    await dialog.getByTestId('consol-adj-credit').nth(1).fill('250');
    await expect(dialog.getByTestId('consol-adj-balance')).toContainText('balanced');
    await dialog.getByTestId('consol-adj-save').click();
    await expect(dialog).toHaveCount(0);
    const adjustment = page
      .getByTestId('consol-adjustment')
      .filter({ hasText: 'Playwright reclassification' });
    await expect(adjustment.first()).toBeVisible();
    await expect(adjustment.first()).toContainText('3100 Dr 250');
  });
});
