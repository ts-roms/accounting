import { expect, test } from '@playwright/test';
import { login } from './helpers';

/** Hardening H6: document numbering rules, the CSV import engine, exports and opening balances. */
test.describe('data infrastructure', () => {
  test.slow();

  test('a branch numbering rule is configured with a live preview and shows its next number', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/numbering');
    await expect(
      page.locator('[data-testid="numbering-rule"][data-type="INV"]').first(),
    ).toBeVisible();
    await page.getByTestId('numbering-add-branch').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('numbering-type').click();
    await page.getByRole('option', { name: 'QT', exact: true }).click();
    await dialog.getByTestId('numbering-scope').click();
    await page.getByRole('option', { name: /CEB/ }).click();
    await dialog.getByTestId('numbering-prefix').fill('QT');
    await dialog.getByTestId('numbering-format').fill('{PREFIX}-{BRANCH}-{YY}-{SEQ}');
    await expect(dialog.getByTestId('numbering-preview')).toHaveText(/^QT-CEB-\d{2}-000001$/);
    await dialog.getByTestId('numbering-save').click();
    await expect(dialog).toHaveCount(0);
    const row = page.locator('[data-testid="numbering-rule"][data-type="QT"][data-scope="CEB"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('numbering-next')).toHaveText(/^QT-CEB-\d{2}-000001$/);
  });

  test('a CSV of vendors is validated, previewed with row errors and committed skipping the invalid row', async ({
    page,
  }) => {
    await login(page);
    const stamp = Date.now().toString().slice(-6);
    await page.goto('/admin/imports');
    await page.getByTestId('import-type').click();
    await page.getByRole('option', { name: 'Vendors' }).click();
    const csv = [
      'code,name,email,payment_terms_days',
      `PW-${stamp}-A,Playwright Vendor A,a@pw.test,15`,
      `PW-${stamp}-B,Playwright Vendor B,not-an-email,30`,
    ].join('\n');
    await page.getByTestId('import-file').setInputFiles({
      name: 'vendors.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv, 'utf8'),
    });
    await page.getByTestId('import-upload').click();
    const preview = page.getByTestId('import-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('import-preview-row')).toHaveCount(2);
    await expect(preview.getByTestId('import-row-errors')).toContainText('email');
    // Financial rules: commit is blocked until invalid rows are skipped.
    await expect(preview.getByTestId('import-commit')).toBeDisabled();
    await preview.getByTestId('import-skip-invalid').click();
    await preview.getByTestId('import-commit').click();
    await expect(preview.getByTestId('import-status')).toHaveText('Committed');
    await expect(
      preview.locator('[data-testid="import-preview-row"][data-errors="0"]'),
    ).toContainText(`PW-${stamp}-A`);
    await expect(page.getByTestId('import-row').first()).toContainText('vendors.csv');
    // The vendor exists.
    await page.goto('/purchasing/vendors');
    await page.getByPlaceholder('Code, name or email').fill(`PW-${stamp}-A`);
    await expect(page.getByRole('row').filter({ hasText: `PW-${stamp}-A` })).toBeVisible();
  });

  test('the opening balance report reconciles and the trial balance exports a CSV', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/accounting/opening-balances');
    await expect(page.getByTestId('ob-status')).toBeVisible();
    await expect(page.getByTestId('ob-area')).toHaveCount(4);
    await expect(page.getByTestId('ob-equity')).toBeVisible();
    await page.goto('/accounting/trial-balance');
    const download = page.waitForEvent('download');
    await page.getByTestId('export-trial_balance').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^trial-balance-\d{8}\.csv$/);
  });
});
