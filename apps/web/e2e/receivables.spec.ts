import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function pickFromCombobox(page: Page, testId: string, search: string) {
  await page.getByTestId(testId).first().click();
  const input = page.getByPlaceholder('Search by code or name...');
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await input.press('Enter');
}

test.describe('receivables', () => {
  // Each flow walks five or six screens; on a cold dev server that exceeds the default budget.
  test.slow();

  test('invoice -> approve -> post -> receipt with allocation -> aging reconciles', async ({
    page,
  }) => {
    await login(page);
    const reference = `E2E-${Date.now()}`;

    // ---- Invoice
    await page.goto('/sales/invoices/new');
    await pickFromCombobox(page, 'party-combobox', 'Cebu');
    await expect(page.getByTestId('party-combobox')).toContainText('Cebu Hardware Supply');
    // Picking the customer fills the due date from its terms and the default revenue account.
    await expect(page.getByLabel('Due date')).not.toHaveValue('');
    await expect(page.getByTestId('account-combobox').first()).toContainText('Sales Revenue');

    await page.getByLabel('Reference / PO').fill(reference);
    await page.getByPlaceholder('What was sold or bought').fill('E2E consulting');
    const decimals = page.locator('input[inputmode="decimal"]');
    await decimals.nth(1).fill('1000'); // unit price (index 0 is quantity)
    await decimals.nth(1).blur();
    await expect(page.locator('tfoot')).toContainText('1,000.00');

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]+$/);
    const invoiceUrl = page.url();
    await expect(page.getByText('DRAFT', { exact: true })).toBeVisible();
    const invoiceNumber = (await page.locator('h1 .font-mono').first().textContent())!.trim();
    expect(invoiceNumber).toMatch(/^INV-2026-\d{6}$/);

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Post to ledger' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByRole('link', { name: /^JE-2026-\d{6}$/ })).toBeVisible();

    // ---- Receipt allocated to the invoice
    await page.goto('/sales/payments/new');
    await pickFromCombobox(page, 'party-combobox', 'Cebu');
    await page.getByTestId('payment-amount').fill('400');
    await page.getByTestId('payment-amount').blur();
    await pickFromCombobox(page, 'account-combobox', '1130');
    await expect(page.getByTestId('account-combobox')).toContainText('Cash in Bank');
    await page.getByLabel('Reference').fill(`${reference}-RCP`);

    const allocation = page.getByLabel(`Allocate to ${invoiceNumber}`);
    await expect(allocation).toBeVisible();
    await allocation.fill('400');
    await expect(page.getByText('On account:')).toContainText('0.00');

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/sales\/payments\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^RCP-2026-\d{6}$/);
    await expect(page.getByRole('link', { name: invoiceNumber })).toBeVisible();

    await page.getByRole('button', { name: 'Post to ledger' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByText('POSTED', { exact: true })).toBeVisible();

    // ---- Invoice is now partially settled
    await page.goto(invoiceUrl);
    await expect(page.getByText('PARTIALLY PAID', { exact: true })).toBeVisible();
    await expect(page.locator('tfoot')).toContainText('600.00');
    await expect(page.getByRole('link', { name: /^RCP-2026-\d{6}$/ })).toBeVisible();

    // ---- Subledger still ties to the AR control account
    await page.goto('/reports/ar-aging');
    await expect(page.getByTestId('reconciliation-card')).toContainText('Reconciled');
    await expect(page.getByTestId('aging-table')).toContainText('Cebu Hardware Supply');
  });

  test('vendor bill lifecycle and AP schedule', async ({ page }) => {
    await login(page);
    const vendorInvoice = `VI-${Date.now()}`;

    await page.goto('/purchasing/bills/new');
    await pickFromCombobox(page, 'party-combobox', 'VEND-001');
    await page.getByLabel('Vendor invoice no.').fill(vendorInvoice);
    await page.getByPlaceholder('What was sold or bought').fill('E2E office supplies');
    await pickFromCombobox(page, 'account-combobox', '6400');
    const decimals = page.locator('input[inputmode="decimal"]');
    await decimals.nth(1).fill('250.5');
    await decimals.nth(1).blur();

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/purchasing\/bills\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^BILL-2026-\d{6}$/);

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('button', { name: 'Post to ledger' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByRole('link', { name: /^JE-2026-\d{6}$/ })).toBeVisible();

    await page.goto('/reports/ap-aging');
    await expect(page.getByTestId('reconciliation-card')).toContainText('Reconciled');
  });
});
