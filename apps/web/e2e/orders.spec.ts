import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function pickFromCombobox(page: Page, testId: string, search: string) {
  await page.getByTestId(testId).first().click();
  const input = page.getByPlaceholder('Search by code or name...');
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await input.press('Enter');
}

async function confirmDialog(page: Page, name: string) {
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
}

test.describe('sales & purchasing', () => {
  test.slow();

  test('quotation -> sales order -> invoice, with a discounted line', async ({ page }) => {
    await login(page);

    await page.goto('/sales/quotations/new');
    await pickFromCombobox(page, 'party-combobox', 'Mindanao');
    await expect(page.getByTestId('account-combobox').first()).toContainText('Sales Revenue');
    await page.getByPlaceholder('Item or service').fill('E2E widgets');
    const decimals = page.locator('input[inputmode="decimal"]');
    await decimals.nth(0).fill('10'); // quantity
    await decimals.nth(1).fill('100'); // unit price
    await decimals.nth(2).fill('10'); // discount %
    await decimals.nth(2).blur();
    await expect(page.locator('tfoot')).toContainText('900.00');

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/sales\/quotations\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^QT-2026-\d{6}$/);

    await page.getByRole('button', { name: 'Customer accepted' }).click();
    await confirmDialog(page, 'Customer accepted');
    await expect(page.getByText('ACCEPTED', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Create sales order' }).click();
    await confirmDialog(page, 'Create sales order');
    await expect(page).toHaveURL(/\/sales\/orders\/[0-9a-f-]+$/);
    const soNumber = (await page.locator('h1 .font-mono').first().textContent())!.trim();
    expect(soNumber).toMatch(/^SO-2026-\d{6}$/);
    await expect(page.locator('tfoot')).toContainText('900.00');

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await confirmDialog(page, 'Approve');
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Create invoice' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Fill remaining' }).click();
    await confirmDialog(page, 'Create invoice');
    await expect(page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^INV-2026-\d{6}$/);
    await expect(page.locator('tfoot')).toContainText('900.00');
    await expect(page.getByRole('link', { name: 'View order' })).toBeVisible();

    // Fully invoiced order auto-closes.
    await page.getByRole('link', { name: 'View order' }).click();
    await expect(page.getByText('CLOSED', { exact: true })).toBeVisible();
    // Scope to the badge: Next's route announcer repeats the heading text while navigating.
    await expect(page.locator('[data-tone]', { hasText: 'Invoiced: full' })).toBeVisible();
  });

  test('purchase order -> partial receipt -> bill with match exceptions -> review', async ({
    page,
  }) => {
    await login(page);
    const vin = `VI-${Date.now()}`;

    await page.goto('/purchasing/orders/new');
    await pickFromCombobox(page, 'party-combobox', 'VEND-002');
    await page.getByPlaceholder('Item or service').fill('E2E toner');
    await pickFromCombobox(page, 'account-combobox', '6400');
    const decimals = page.locator('input[inputmode="decimal"]');
    await decimals.nth(0).fill('10');
    await decimals.nth(1).fill('50');
    await decimals.nth(1).blur();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]+$/);
    const poUrl = page.url();

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await confirmDialog(page, 'Approve');
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();

    // Receive 6 of 10.
    await page.getByRole('button', { name: 'Receive goods' }).click();
    await page.getByLabel('Quantity for line 1').fill('6');
    await confirmDialog(page, 'Create receipt');
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    await confirmDialog(page, 'Confirm receipt');
    await expect(page.getByText('CONFIRMED', { exact: true })).toBeVisible();

    // Bill the full 10 -> quantity mismatch.
    await page.goto(poUrl);
    await expect(page.getByText('Received: partial')).toBeVisible();
    await page.getByRole('button', { name: 'Create bill' }).click();
    await page.getByLabel('Vendor invoice no.').fill(vin);
    await page.getByLabel('Quantity for line 1').fill('10');
    await confirmDialog(page, 'Create bill');
    await expect(page).toHaveURL(/\/purchasing\/bills\/[0-9a-f-]+$/);
    await expect(page.getByTestId('match-status')).toHaveText('Match exception');
    await expect(page.getByTestId('match-card')).toContainText('Quantity Mismatch');

    await page.getByRole('button', { name: 'Review exceptions' }).click();
    await page
      .getByLabel('Review note')
      .fill('Balance arriving next week; supplier bills on dispatch.');
    await confirmDialog(page, 'Mark as reviewed');
    await expect(page.getByTestId('match-status')).toHaveText('Exception reviewed');
  });

  test('purchasing settings and AP reconciliation stay consistent', async ({ page }) => {
    await login(page);
    await page.goto('/purchasing/settings');
    await expect(page.getByLabel('Price tolerance %')).toHaveValue('2');
    await page.goto('/reports/ap-aging');
    await expect(page.getByTestId('reconciliation-card')).toContainText('Reconciled');
  });
});
