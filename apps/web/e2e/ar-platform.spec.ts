import { expect, test } from './fixtures';
import { login } from './helpers';

/**
 * Prompt #6 - Receivables section. Runs against the seeded development stack
 * (ten customers, overdue invoices, collection cases, a pending write-off).
 */
test.describe('receivables platform', () => {
  test.slow();

  test('AR dashboard shows real receivables, aging and collections figures', async ({ page }) => {
    await login(page);
    await page.goto('/receivables/dashboard');
    await expect(page.getByRole('heading', { name: 'AR Dashboard' })).toBeVisible();
    await expect(page.getByText('Total receivables')).toBeVisible();
    await expect(page.getByText('DSO', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: 'AR aging' })).toBeVisible();
    await expect(page.getByText('Largest overdue balances')).toBeVisible();
    await expect(page.getByText('Province of Agusan del Norte')).toBeVisible();
  });

  test('collections workspace lists cases and opens a case with its timeline', async ({ page }) => {
    await login(page);
    await page.goto('/receivables/collections');
    await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible();
    await expect(page.getByText('Tagum Farm Supply')).toBeVisible();
    await page.getByText('Tagum Farm Supply').click();
    await expect(page).toHaveURL(/\/receivables\/collections\/[0-9a-f-]+$/);
    await expect(page.getByRole('heading', { name: /Tagum Farm Supply/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Activities' })).toBeVisible();
    await expect(page.getByText('Escalation to collections - 30 days overdue')).toBeVisible();
    await page.getByRole('tab', { name: 'Open invoices' }).click();
    await expect(page.getByText('INV-2026-', { exact: false }).first()).toBeVisible();
  });

  test('customer page shows the credit card, master data and collections tabs', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/sales/customers');
    await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
    await page.getByPlaceholder(/Code, name/i).fill('Tagum');
    await page.getByText('Tagum Farm Supply').first().click();
    await expect(page).toHaveURL(/\/sales\/customers\/[0-9a-f-]+$/);
    await expect(page.getByText('Credit used = posted balance', { exact: false })).toBeVisible();
    await expect(page.getByText('Available credit')).toBeVisible();
    await expect(page.getByText('On Hold', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Profile & contacts' }).click();
    await expect(page.getByText('Benjie Lim')).toBeVisible();
    await page.getByRole('tab', { name: 'Collections' }).click();
    await expect(page.getByText('COL-2026-', { exact: false }).first()).toBeVisible();
  });

  test('write-offs, disputes, reconciliation and settings screens render from live data', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/receivables/write-offs');
    await expect(page.getByRole('heading', { name: 'Write-Offs' })).toBeVisible();
    await expect(page.getByText('WO-2026-000001')).toBeVisible();
    await page.goto('/receivables/disputes');
    await expect(page.getByRole('heading', { name: 'Disputes' })).toBeVisible();
    await expect(page.getByText('Manila Bay Resorts')).toBeVisible();
    await page.goto('/receivables/reconciliation');
    await expect(page.getByRole('heading', { name: 'AR Reconciliation' })).toBeVisible();
    await expect(page.getByText('Reconciled', { exact: true })).toBeVisible();
    await expect(page.getByText('AR integrity checks')).toBeVisible();
    await page.goto('/receivables/settings');
    await expect(page.getByRole('heading', { name: 'Receivables Settings' })).toBeVisible();
    await page.getByRole('tab', { name: 'Dunning' }).click();
    await expect(page.getByText('Standard dunning')).toBeVisible();
    await page.getByRole('tab', { name: 'Credit rules' }).click();
    await expect(page.getByText('Block new orders when overdue exceeds 250,000')).toBeVisible();
  });
});
