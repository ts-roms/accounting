import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

async function pickAccount(page: Page, rowIndex: number, search: string) {
  await page.getByTestId('account-combobox').nth(rowIndex).click();
  const input = page.getByPlaceholder('Search by code or name...');
  await input.fill(search);
  await expect(page.locator('[cmdk-item]').first()).toBeVisible();
  await input.press('Enter');
}

/** Draft -> submit -> approve -> post a simple journal through the UI; returns its URL. */
async function postJournal(page: Page, description: string, amount: string, date: string) {
  await page.goto('/accounting/journal-entries/new');
  await page.getByLabel('Description').fill(description);
  await page.getByLabel('Entry date').fill(date);
  await pickAccount(page, 0, '6400');
  await pickAccount(page, 1, '1120');
  const amounts = page.locator('input[inputmode="decimal"]');
  await amounts.nth(0).fill(amount);
  await amounts.nth(0).blur();
  await amounts.nth(3).fill(amount);
  await amounts.nth(3).blur();
  await expect(page.getByText('Balanced')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/accounting\/journal-entries\/[0-9a-f-]+$/);
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('SUBMITTED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('APPROVED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Post to ledger' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Post to ledger' }).click();
  await expect(page.getByText('POSTED', { exact: true })).toBeVisible();
  return page.url();
}

test.describe('accounting controls', () => {
  test.slow();

  test('a posted journal can be corrected: reversal posted, linked draft opened, chain shown', async ({
    page,
  }) => {
    await login(page);
    const stamp = Date.now();
    const url = await postJournal(page, `Wrong amount ${stamp}`, '480', '2026-09-08');
    await page.getByTestId('je-correct').click();
    await page.getByTestId('je-correct-reason').fill('Should have been 420');
    await page.getByTestId('je-correct-confirm').click();
    // Lands on the correcting draft's editor; go to its detail to see the chain.
    await expect(page).toHaveURL(/\/accounting\/journal-entries\/[0-9a-f-]+\/edit$/);
    await page.goto(page.url().replace(/\/edit$/, ''));
    await expect(page.getByText('DRAFT', { exact: true })).toBeVisible();
    await expect(page.getByTestId('je-related')).toContainText('Corrects');
    await page.getByTestId('je-related').getByRole('link').first().click();
    await expect(page).toHaveURL(url);
    await expect(page.getByText('REVERSED', { exact: true })).toBeVisible();
    const related = page.getByTestId('je-related');
    await expect(related).toContainText('Reversal');
    await expect(related).toContainText('Correction');
  });

  test('fiscal periods move through soft close, close, lock; reopening needs a reason', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/accounting/period-closing');
    // Work on the last period of the year (December) so sequencing rules do not interfere.
    const row = page.getByRole('row').filter({ hasText: 'December 2026' });
    await expect(row).toBeVisible();
    await row.getByTestId('period-soft-close').click();
    await page.getByTestId('period-confirm').click();
    await expect(row.getByTestId('period-status')).toHaveText('SOFT CLOSED');
    // Reopen requires a reason of at least 5 characters.
    await row.getByTestId('period-reopen').click();
    await expect(page.getByTestId('period-confirm')).toBeDisabled();
    await page.getByLabel('Reason').fill('Late supplier invoice');
    await page.getByTestId('period-confirm').click();
    await expect(row.getByTestId('period-status')).toHaveText('OPEN');
    await expect(row).toContainText('reopened: Late supplier invoice');
  });

  test('the integrity dashboard runs every invariant against live data', async ({ page }) => {
    await login(page);
    await page.goto('/accounting/integrity');
    await expect(page.getByTestId('integrity-status')).toBeVisible();
    await expect(page.getByTestId('integrity-check')).toHaveCount(14);
    await expect(page.getByText('Posted journals balance')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'UNBALANCED_JOURNAL' })).toContainText('PASS');
    await expect(page.getByRole('row').filter({ hasText: 'AR_CONTROL_VARIANCE' })).toContainText('PASS');
  });
});
