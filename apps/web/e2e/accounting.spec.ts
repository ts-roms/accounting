import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function pickAccount(page: Page, rowIndex: number, search: string) {
  await page.getByTestId('account-combobox').nth(rowIndex).click();
  const input = page.getByPlaceholder('Search by code or name...');
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await input.press('Enter');
}

test.describe('accounting core', () => {
  test('creates, approves, posts and drills into a journal entry', async ({ page }) => {
    await login(page);
    const description = `E2E supplies ${Date.now()}`;

    await page.goto('/accounting/journal-entries/new');
    await page.getByLabel('Description').fill(description);
    await page.getByLabel('Entry date').fill('2026-09-05');

    // Keyboard-driven account selection: type, Enter.
    await pickAccount(page, 0, '6400');
    await expect(page.getByTestId('account-combobox').nth(0)).toContainText(
      'Office Supplies Expense',
    );
    await pickAccount(page, 1, '1120');
    await expect(page.getByTestId('account-combobox').nth(1)).toContainText('Petty Cash');

    const amounts = page.locator('input[inputmode="decimal"]:not([data-testid="je-rate"])');
    await amounts.nth(0).fill('345.67');
    await amounts.nth(0).blur();
    await expect(page.getByText('Out of balance')).toBeVisible();
    await amounts.nth(3).fill('345.67');
    await amounts.nth(3).blur();
    await expect(page.getByText('Balanced')).toBeVisible();

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/accounting\/journal-entries\/[0-9a-f-]+$/);
    await expect(page.getByText('DRAFT', { exact: true })).toBeVisible();
    const documentNumber = (await page.locator('h1 .font-mono').first().textContent())!.trim();
    expect(documentNumber).toMatch(/^JE-2026-\d{6}$/);

    // Lifecycle through the confirmation dialogs.
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByText('SUBMITTED', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();
    await expect(page.getByText('Segregation-of-duties warning recorded')).toBeVisible();

    await page.getByRole('button', { name: 'Post to ledger' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Post to ledger' }).click();
    await expect(page.getByText('POSTED', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reverse' })).toBeVisible();

    // Drill down: line account -> general ledger shows the posted document.
    await page.getByRole('link', { name: 'Petty Cash' }).click();
    await expect(page).toHaveURL(/\/accounting\/general-ledger\?accountId=/);
    await expect(page.getByRole('link', { name: documentNumber })).toBeVisible();
    await expect(page.getByText('Closing balance').first()).toBeVisible();
  });

  test('trial balance and balance sheet stay balanced', async ({ page }) => {
    await login(page);
    await page.goto('/accounting/trial-balance');
    await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
    await page.goto('/reports/financial-statements');
    await page.getByRole('tab', { name: 'Balance Sheet' }).click();
    await expect(page.getByText('Assets = Liabilities + Equity')).toBeVisible();
    await expect(page.getByText('Total assets', { exact: true }).first()).toBeVisible();
  });

  test('chart of accounts lists the hierarchy and the mappings tab', async ({ page }) => {
    await login(page);
    await page.goto('/accounting/chart-of-accounts');
    await expect(page.getByText('Cash in Bank - BDO')).toBeVisible();
    await page.getByRole('tab', { name: 'Account mappings' }).click();
    await expect(page.getByText('RETAINED_EARNINGS')).toBeVisible();
    await expect(page.getByText('Retained Earnings', { exact: true }).first()).toBeVisible();
  });
});
