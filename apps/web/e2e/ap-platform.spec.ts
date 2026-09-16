import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * Prompt #7 - Payables section. Runs against the seeded development stack
 * (ten vendors, bills across every bucket, a payment hold, a payment run, a
 * draft accrual).
 */
test.describe('payables platform', () => {
  test.slow();

  test('AP dashboard shows real payables, cash requirements and vendor figures', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/payables/dashboard');
    await expect(page.getByRole('heading', { name: 'AP Dashboard' })).toBeVisible();
    await expect(page.getByText('Total payables')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('DPO', { exact: true })).toBeVisible();
    await expect(page.getByText('Received not billed', { exact: true })).toBeVisible();
    await expect(page.getByText('Largest vendor balances')).toBeVisible();
    await expect(page.getByText('Pacific IT Consulting')).toBeVisible();
  });

  test('payment runs list opens a run with its lines and totals', async ({ page }) => {
    await login(page);
    await page.goto('/payables/payment-runs');
    await expect(page.getByRole('heading', { name: 'Payment Runs' })).toBeVisible();
    await expect(page.getByText('PMR-2026-', { exact: false }).first()).toBeVisible();
    await page.getByText('PMR-2026-', { exact: false }).first().click();
    await expect(page).toHaveURL(/\/payables\/payment-runs\/[0-9a-f-]+$/);
    await expect(page.getByText('Bills in this run')).toBeVisible();
    await expect(page.getByText('Luzon Facilities Management').first()).toBeVisible();
    await expect(page.getByText('Per vendor', { exact: true })).toBeVisible();
  });

  test('vendor page shows the vendor card, hold trail and master data tab', async ({ page }) => {
    await login(page);
    await page.goto('/purchasing/vendors');
    await expect(page.getByRole('heading', { name: 'Vendors' })).toBeVisible();
    await page.getByPlaceholder(/Code, name/i).fill('Iloilo');
    await page.getByText('Iloilo Steel Fabricators').first().click();
    await expect(page).toHaveURL(/\/purchasing\/vendors\/[0-9a-f-]+$/);
    await expect(page.getByText('On Hold', { exact: true })).toBeVisible();
    await expect(page.getByText('on payment hold', { exact: false })).toBeVisible();
    await page.getByRole('tab', { name: 'Profile & contacts' }).click();
    await expect(page.getByText('Bank accounts')).toBeVisible();
    await expect(page.getByText('Ana Reyes').first()).toBeVisible();
    await expect(page.getByText('******9900')).toBeVisible();
  });

  test('holds, GRNI, accruals, reconciliation and settings screens render from live data', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/payables/holds');
    await expect(page.getByRole('heading', { name: 'Payment Holds' })).toBeVisible();
    await expect(page.getByText('Quality Issue')).toBeVisible();
    await page.goto('/payables/grni');
    await expect(page.getByRole('heading', { name: 'Received Not Billed' })).toBeVisible();
    await expect(page.getByText('Services (to accrue)')).toBeVisible();
    await page.goto('/payables/accruals');
    await expect(page.getByRole('heading', { name: 'AP Accruals' })).toBeVisible();
    await expect(page.getByText('ACR-2026-000001')).toBeVisible();
    await page.goto('/payables/reconciliation');
    await expect(page.getByRole('heading', { name: 'AP Reconciliation' })).toBeVisible();
    await expect(page.getByText('Reconciled', { exact: true })).toBeVisible();
    await expect(page.getByText('AP integrity checks')).toBeVisible();
    await page.goto('/payables/settings');
    await expect(page.getByRole('heading', { name: 'Payables Settings' })).toBeVisible();
    await page.getByRole('tab', { name: 'Vendor groups' }).click();
    await expect(page.getByText('Goods suppliers')).toBeVisible();
  });
});
