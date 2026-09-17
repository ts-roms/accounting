import { expect, test } from './fixtures';
import { FINANCE, login } from './helpers';

const stamp = Date.now().toString().slice(-6);

test.describe('budgeting, tax & expense claims', () => {
  test.slow();

  test('tax codes list the seeded VAT; variance report shows the seeded budget', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/tax/codes');
    await expect(page.getByTestId('tax-code-row').filter({ hasText: 'VAT12' })).toBeVisible();
    await expect(page.getByTestId('tax-code-row').filter({ hasText: 'VAT12' })).toContainText(
      '12%',
    );

    await page.goto('/budgeting/variance');
    await expect(page.getByTestId('variance-row').first()).toBeVisible();
    await expect(page.getByTestId('variance-row').filter({ hasText: '6400' })).toContainText(
      '60,000.00',
    );

    await page.goto('/budgeting/dimensions');
    await expect(page.getByTestId('dimension-row').filter({ hasText: 'SALES' })).toBeVisible();
  });

  test('expense claim: create with tax-inclusive line -> submit -> approve by finance -> post', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/budgeting/expense-claims/new');
    await page.getByTestId('claim-purpose').fill(`Client visit ${stamp}`);
    await page.getByTestId('claim-line-description').first().fill('Taxi');
    await page.getByTestId('account-combobox').first().click();
    await page.getByPlaceholder('Search by code or name...').fill('6400');
    await page.locator('[cmdk-item]').first().click();
    await page.getByTestId('claim-line-tax').first().click();
    await page.getByRole('option', { name: /VAT12/ }).click();
    await page.getByTestId('claim-line-amount').first().fill('1120');
    await expect(page.getByTestId('claim-total')).toContainText('1,120.00');
    await page.getByTestId('claim-save').click();
    await expect(page).toHaveURL(/\/budgeting\/expense-claims\/[0-9a-f-]+$/);
    await expect(page.locator('h1 .font-mono').first()).toHaveText(/^EXP-2026-\d{6}$/);
    await expect(page.getByTestId('claim-line').first()).toContainText('VAT12 12% = 120.0000');
    const url = page.url();

    await page.getByTestId('claim-submit').click();
    await expect(page.getByText('Submitted', { exact: true })).toBeVisible();
    // The claimant cannot approve their own claim: the button is disabled for admin.
    await expect(page.getByTestId('claim-approve')).toBeDisabled();

    await login(page, FINANCE);
    await page.goto(url);
    await page.getByTestId('claim-approve').click();
    await expect(page.getByText('Approved', { exact: true })).toBeVisible();
    await page.getByTestId('claim-post').click();
    await expect(page.getByText('Posted', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /^JE-2026-\d{6}$/ })).toBeVisible();
  });
});
