import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function pickFromCombobox(page: Page, testId: string, search: string) {
  await page.getByTestId(testId).first().click();
  const input = page.getByPlaceholder('Search by code or name...');
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await input.press('Enter');
}

/** Hardening H5: control center, suspense monitor, field history, SoD conflicts, workflow deadlines. */
test.describe('enterprise controls', () => {
  test.slow();

  test('the control center summarises every control and links to its area', async ({ page }) => {
    await login(page);
    await page.goto('/accounting/control-center');
    await expect(page.getByTestId('controls-status')).toBeVisible();
    await expect(page.getByTestId('control-tile')).toHaveCount(10);
    const unbalanced = page.locator('[data-testid="control-tile"][data-key="UNBALANCED_JOURNALS"]');
    await expect(unbalanced).toHaveAttribute('data-severity', 'OK');
    await expect(unbalanced.getByTestId('control-value')).toHaveText('0');
    await expect(
      page.locator('[data-testid="control-tile"][data-key="SOD_CONFLICTS"]'),
    ).toHaveAttribute('data-severity', 'WARNING');
    await expect(page.getByTestId('control-section').first()).toBeVisible();
    // Tiles drill down.
    await page.locator('[data-testid="control-tile"][data-key="SUSPENSE_BALANCE"]').click();
    await expect(page).toHaveURL(/\/accounting\/suspense$/);
    await expect(page.getByTestId('suspense-account')).toHaveCount(3);
    // 1900 Suspense is untouched by the other specs (the asset spec parks a capitalisation in 1590).
    await expect(
      page
        .locator('[data-testid="suspense-account"][data-code="1900"]')
        .getByTestId('suspense-status'),
    ).toHaveText('CLEAR');
    await expect(page.getByTestId('suspense-flagged')).toBeVisible();
  });

  test('editing an invoice with a reason shows up in its change history', async ({ page }) => {
    await login(page);
    const reference = `H5-${Date.now()}`;
    await page.goto('/sales/invoices/new');
    await pickFromCombobox(page, 'party-combobox', 'Cebu');
    await expect(page.getByTestId('account-combobox').first()).toContainText('Sales Revenue');
    await page.getByLabel('Reference / PO').fill(reference);
    await page.getByPlaceholder('What was sold or bought').fill('H5 consulting');
    const decimals = page.locator('input[inputmode="decimal"]');
    await decimals.nth(1).fill('1000');
    await decimals.nth(1).blur();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]+$/);
    await expect(page.getByTestId('history-panel')).toContainText('No field changes recorded');
    // Edit the price and give a reason.
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(/\/edit$/);
    const editPrice = page.locator('input[inputmode="decimal"]').nth(1);
    await editPrice.fill('1100');
    await editPrice.blur();
    await page.getByTestId('doc-change-reason').fill('Additional approved service');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]+$/);
    const row = page.locator('[data-testid="history-row"][data-field="total"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('1000.0000');
    await expect(row).toContainText('1100.0000');
    await expect(row).toContainText('Additional approved service');
  });

  test('the SoD tab lists standing conflicts; a workflow can carry a deadline and escalation', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/roles');
    await page.getByRole('tab', { name: 'Segregation of duties' }).click();
    await expect(page.getByTestId('sod-conflict').first()).toBeVisible();
    await expect(page.getByTestId('sod-conflict').first()).toContainText('WARN');

    await page.goto('/admin/workflows');
    await page.getByRole('button', { name: 'New workflow' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(`Deadline ${Date.now()}`);
    // Far above any amount the other specs post, so no journal is gated by this workflow.
    await dialog.getByLabel('Applies from amount').fill('999999999');
    await dialog.getByTestId('workflow-deadline').fill('48');
    await dialog.getByTestId('workflow-escalation').click();
    await page.getByRole('option', { name: 'period.close', exact: true }).click();
    await dialog.getByRole('button', { name: /Create|Save/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/Deadline \d+/).first()).toBeVisible();
  });
});
