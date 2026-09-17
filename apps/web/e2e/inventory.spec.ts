import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { login } from './helpers';

async function pickProduct(page: Page, search: string) {
  await page.getByTestId('product-combobox').first().click();
  const input = page.getByPlaceholder('Search by SKU or name...');
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await input.press('Enter');
}

test.describe('inventory', () => {
  test.slow();

  test('stock adjustment in -> post -> stock card and valuation reconcile', async ({ page }) => {
    await login(page);

    await page.goto('/inventory/adjustments/new');
    await page.getByTestId('warehouse-select').first().click();
    await page.getByRole('option', { name: /MAIN/ }).click();
    await page.getByTestId('adjustment-reason').click();
    await page.getByRole('option', { name: 'Found' }).click();
    await pickProduct(page, 'MERCH-002');
    await page.getByLabel('Direction for line 1').click();
    await page.getByRole('option', { name: 'Stock in' }).click();
    await page.getByLabel('Quantity for line 1').fill('3');
    await page.getByLabel('Unit cost for line 1').fill('12000');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/inventory\/adjustments\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^ADJ-2026-\d{6}$/);
    await expect(page.getByText('DRAFT', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByText('POSTED', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^JE-2026-\d{6}$/ })).toBeVisible();
    await expect(page.locator('tfoot')).toContainText('36,000.00');

    // Product stock card shows the movement and the new balance.
    await page.getByRole('link', { name: /Heavy-duty shelving bay/ }).click();
    await expect(page).toHaveURL(/\/inventory\/products\/[0-9a-f-]+$/);
    await expect(page.getByTestId('stock-card')).toContainText('Adjustment In');

    // Subledger ties to the inventory control account.
    await page.goto('/inventory/valuation');
    await expect(page.getByTestId('inventory-reconciliation')).toContainText('Reconciled');
  });

  test('stock on hand lists the seeded balance and warehouses render', async ({ page }) => {
    await login(page);
    await page.goto('/inventory/stock');
    await expect(page.getByTestId('stock-on-hand')).toContainText('MERCH-001');
    await page.goto('/inventory/warehouses');
    await expect(page.getByTestId('warehouse-card').filter({ hasText: 'MAIN' })).toBeVisible();
  });
});
