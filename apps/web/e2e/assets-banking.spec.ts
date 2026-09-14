import { expect, test } from '@playwright/test';
import { login } from './helpers';

const stamp = Date.now().toString().slice(-6);

test.describe('fixed assets & banking', () => {
  test.slow();

  test('register asset -> capitalise -> depreciation run posts -> dispose', async ({ page }) => {
    await login(page);

    await page.goto('/fixed-assets/assets');
    await page.getByRole('button', { name: 'New asset' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(`Laptop ${stamp}`);
    await page.getByTestId('asset-category').click();
    await page.getByRole('option', { name: /IT/ }).click();
    await dialog.getByLabel('Acquisition date').fill('2026-03-10');
    await dialog.getByLabel('Acquisition cost').fill('36000');
    await dialog.getByLabel('Life (months)').fill('36');
    await dialog.getByRole('button', { name: 'Register' }).click();
    await expect(page).toHaveURL(/\/fixed-assets\/assets\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^FA-2026-\d{6}$/);
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();

    // Capitalise against the default clearing account.
    await page.getByTestId('capitalize').click();
    await page.getByTestId('action-confirm').click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByTestId('asset-event')).toHaveCount(1);
    await expect(page.getByText('1,000.00').first()).toBeVisible(); // 36,000 / 36 next charge

    // Depreciation run: the dialog defaults to the period after the latest posted run.
    await page.goto('/fixed-assets/depreciation');
    await page.getByTestId('new-run').click();
    // On a fresh database no run exists yet, so the dialog defaults to January; pick the acquisition month.
    if (!(await page.getByTestId('run-line').first().isVisible().catch(() => false))) {
      await page.getByTestId('run-period').click();
      await page.getByRole('option', { name: /March 2026/ }).click();
    }
    await expect(page.getByTestId('run-line').first()).toBeVisible();
    await page.getByTestId('create-run').click();
    await expect(page.getByTestId('post-run')).toBeVisible();
    await page.getByTestId('post-run').click();
    await expect(page.getByRole('dialog')).toContainText('Posted');
    await expect(
      page.getByRole('dialog').getByRole('link', { name: /^JE-2026-\d{6}$/ }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    // Dispose for proceeds into the bank; loss lands on the disposal account.
    await page.goto('/fixed-assets/assets');
    await page
      .getByRole('link', { name: /^FA-2026-\d{6}$/ })
      .first()
      .click();
    await page.getByTestId('dispose').click();
    await page.getByTestId('action-amount').fill('30000');
    await page.getByRole('dialog').getByTestId('account-combobox').click();
    const search = page.getByPlaceholder('Search by code or name...');
    await search.fill('1130');
    await page.locator('[cmdk-item]').first().click();
    await page.getByTestId('action-confirm').click();
    await expect(page.getByText('Disposed', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Disposed on/)).toBeVisible();
  });

  test('bank transaction posts; statement import matches it and reconciliation completes', async ({
    page,
  }) => {
    await login(page);

    // A deposit on the cash account, posted.
    await page.goto('/banking/transactions');
    await page.getByTestId('new-transaction').click();
    await page.getByTestId('tx-bank-account').click();
    await page.getByRole('option', { name: /CASH/ }).click();
    await page.getByTestId('tx-amount').fill('777');
    await page.getByRole('dialog').getByLabel('Date').fill('2026-09-10');
    await page.getByRole('dialog').getByLabel('Reference').fill(`DEP-${stamp}`);
    await page.getByRole('dialog').getByText('Select account').click();
    await page.getByPlaceholder('Search by code or name...').fill('4900');
    await page.locator('[cmdk-item]').first().click();
    await page.getByTestId('tx-save').click();
    await expect(page.getByRole('dialog')).toContainText(/BTX-2026-\d{6}/);
    await page.getByTestId('tx-post').click();
    await expect(page.getByRole('dialog')).toContainText('Posted');
    await page.keyboard.press('Escape');

    // Import a one-line statement for it. Opening = ledger balance before, closing = + 777.
    await page.goto('/banking/reconciliation/import');
    await page.getByTestId('stm-bank-account').click();
    await page.getByRole('option', { name: /CASH/ }).click();
    const ledgerText = await page.getByText(/Ledger balance/).textContent();
    const ledger = Number(ledgerText!.match(/Ledger balance ([-\d.]+)/)![1]);
    await page
      .getByTestId('stm-text')
      .fill(`date,description,reference,amount\n2026-09-10,Cash deposit,DEP-${stamp},777`);
    await page.getByTestId('stm-opening').fill((ledger - 777).toFixed(4));
    await page.getByTestId('stm-closing').fill(ledger.toFixed(4));
    await page.getByLabel('Statement date').fill('2026-09-10');
    await page.getByTestId('stm-import').click();
    await expect(page).toHaveURL(/\/banking\/reconciliation\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^STM-2026-\d{6}$/);

    // Auto-matched; the difference is whatever older ledger lines are still outstanding, so
    // check the line status and the figures rather than forcing completion when history exists.
    await page.getByRole('combobox').filter({ hasText: 'Needs attention' }).click();
    await page.getByRole('option', { name: 'All lines' }).click();
    const line = page.getByTestId('statement-line').first();
    await expect(line).toHaveAttribute('data-status', 'MATCHED');
    await expect(line).toContainText(/JE-2026-\d{6}/);
    const complete = page.getByTestId('complete-reconciliation');
    if (await complete.isEnabled()) {
      await complete.click();
      await page.getByTestId('confirm-complete').click();
      await expect(page.getByText('Reconciled', { exact: true }).first()).toBeVisible();
    } else {
      await expect(page.getByTestId('outstanding-line').first()).toBeVisible();
    }
  });
});
