import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * Prompt #8 - Treasury section. Runs against the seeded development stack
 * (two bank accounts with profiles, a settled and an in-flight transfer,
 * planned forecast items, an acknowledged payment file, a petty cash fund
 * with posted / approved / draft vouchers).
 */
test.describe('treasury platform', () => {
  test.slow();

  test('cash dashboard shows position, days cash on hand and the forecast from the ledger', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/treasury/dashboard');
    await expect(page.getByRole('heading', { name: 'Cash Dashboard' })).toBeVisible();
    await expect(page.getByText('Total cash', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Days cash on hand', { exact: true })).toBeVisible();
    await expect(page.getByText('Lowest forecast balance')).toBeVisible();
    await expect(page.getByText('Petty cash imprest')).toBeVisible();
    await expect(page.getByText('Cash by bank')).toBeVisible();
    await expect(page.getByRole('cell', { name: /BDO Unibank/ }).first()).toBeVisible();
    await expect(page.getByText('BTR-2026-000002')).toBeVisible(); // sent in August, still unsettled
  });

  test('cash position and forecast screens render every bank account and planned item', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/treasury/position');
    await expect(page.getByRole('heading', { name: 'Cash Position' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'BDO-MAIN' })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('link', { name: 'BPI-SAVE' })).toBeVisible();
    await expect(page.getByText('By currency')).toBeVisible();
    await page.goto('/treasury/forecast');
    await expect(page.getByRole('heading', { name: 'Cash Forecast' })).toBeVisible();
    await expect(page.getByText('Opening cash', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Projected balance')).toBeVisible();
    await expect(page.getByText('Planned items', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('Term loan amortisation')).toBeVisible();
    await expect(page.getByText('Customer invoices (probability-weighted)').first()).toBeVisible();
  });

  test('bank transfer detail shows both legs and the lifecycle timeline', async ({ page }) => {
    await login(page);
    await page.goto('/treasury/transfers');
    await expect(page.getByRole('heading', { name: 'Bank Transfers' })).toBeVisible();
    await page.getByText('BTR-2026-000001').click();
    await expect(page).toHaveURL(/\/treasury\/transfers\/[0-9a-f-]+$/);
    await expect(page.getByText('Sent (cash in transit)')).toBeVisible();
    await expect(page.getByText('Settled', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('300,000.00').first()).toBeVisible();
    await expect(page.getByText('Lifecycle')).toBeVisible();
  });

  test('a small transfer can be drafted, sent and settled from the UI and lands in the ledger', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/treasury/transfers');
    await page.getByRole('button', { name: 'New transfer' }).click();
    await page.getByLabel('From account').click();
    await page.getByRole('option', { name: /BDO-MAIN/ }).click();
    await page.getByLabel('To account').click();
    await page.getByRole('option', { name: /BPI-SAVE/ }).click();
    await page.getByLabel('Amount', { exact: true }).fill('1500');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(/\/treasury\/transfers\/[0-9a-f-]+$/, { timeout: 30_000 });
    await expect(page.getByText('Under the approval threshold')).toBeVisible();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Sent (cash in transit)')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Settle' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Settle' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Settle', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText('Settled').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/JE-2026-\d+ \/ JE-2026-\d+/)).toBeVisible();
  });

  test('payment files and petty cash screens render seeded data and open their details', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/treasury/payment-files');
    await expect(page.getByRole('heading', { name: 'Payment Files' })).toBeVisible();
    await page.getByText('PMF-2026-000001').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Luzon Facilities Management Services')).toBeVisible();
    await expect(page.getByText('******6677')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/treasury/petty-cash');
    await expect(page.getByRole('heading', { name: 'Petty Cash' })).toBeVisible();
    await expect(page.getByText('PCF-HO Head office petty cash')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Expected on hand')).toBeVisible();
    await page.getByText('PCV-2026-000001').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('National Book Store', { exact: true })).toBeVisible();
    await expect(page.getByText('A4 paper (5 reams) and toner')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/treasury/settings');
    await expect(page.getByRole('heading', { name: 'Treasury Settings' })).toBeVisible();
    await expect(page.getByText('Bank account profiles')).toBeVisible();
    await expect(page.getByText('Treasury integrity')).toBeVisible();
    await expect(page.getByText('Cash in transit equals open transfers').first()).toBeVisible({
      timeout: 45_000,
    });
  });
});
