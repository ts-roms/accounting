import { expect, test } from './fixtures';
import { login } from './helpers';

const stamp = Date.now().toString().slice(-6);

const INVOICE_TEXT = `PhilPower Utilities
TIN: 666-777-888-000
INVOICE
Invoice No: PPU-${stamp}
Invoice Date: 2026-09-01
Due Date: 2026-09-30
Bill To: Acme Trading Corporation

Description   Qty   Unit Price   Amount
Electricity consumption August   1   18,500.00   18,500.00

Subtotal   18,500.00
Total Amount Due   PHP 18,500.00
`;

test.describe('ai assistance (advisory only)', () => {
  test.slow();

  test('intake reads a text invoice, matches the vendor and drafts a bill that stays a draft', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/ai/intake');
    await expect(page.getByTestId('ai-advisory')).toContainText('Advisory only');
    await page.getByTestId('intake-upload').click();
    await page.getByTestId('intake-file').setInputFiles({
      name: `ppu-${stamp}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(INVOICE_TEXT),
    });
    await page.getByTestId('intake-submit').click();
    await expect(page).toHaveURL(/\/ai\/intake\/[0-9a-f-]+$/);
    await expect(page.getByText('Extracted', { exact: true })).toBeVisible();
    await expect(page.getByTestId('intake-reference')).toHaveValue(`PPU-${stamp}`);
    await expect(page.getByTestId('intake-total')).toHaveValue('18500.0000');
    await expect(page.getByTestId('party-combobox')).toContainText('PhilPower Utilities');
    await expect(page.getByTestId('intake-line')).toHaveCount(1);
    await expect(page.getByTestId('intake-line-hint').first()).toContainText('%');

    await page.getByTestId('intake-draft-bill').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create draft bill' }).click();
    await expect(page.getByTestId('intake-drafted')).toContainText('BILL-2026-');
    await page.getByTestId('intake-drafted').getByRole('link').click();
    await expect(page).toHaveURL(/\/purchasing\/bills\/[0-9a-f-]+$/);
    await expect(page.getByText('DRAFT', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('18,500.00').first()).toBeVisible();
    await expect(
      page.getByTestId('attachment-row').filter({ hasText: `ppu-${stamp}.txt` }),
    ).toBeVisible();
  });

  test('the assistant answers from posted reports with sources', async ({ page }) => {
    await login(page);
    await page.goto('/ai/assistant');
    await page.getByTestId('assistant-input').fill('Which vendors do we owe the most?');
    await page.getByTestId('assistant-send').click();
    const answer = page.getByTestId('assistant-answer').last();
    await expect(answer).toContainText('Vendors we owe the most');
    await expect(answer).toContainText('AP aging');
    await page.getByTestId('assistant-input').fill('Does the trial balance balance this year?');
    await page.getByTestId('assistant-send').click();
    await expect(page.getByTestId('assistant-answer').last()).toContainText('balances');
    await expect(page.getByTestId('assistant-question')).toHaveCount(2);
  });

  test('anomaly scan flags posted data and a flag can be confirmed', async ({ page }) => {
    await login(page);
    await page.goto('/ai/anomalies');
    await page.getByTestId('anomaly-scan').click();
    await expect(page.getByText(/Scanned \d+ documents/)).toBeVisible();
    const row = page
      .getByRole('row')
      .filter({ hasText: /duplicate|round|person|backdated|control/i })
      .first();
    await expect(row).toBeVisible();
    // The Document cell links to the flagged record; click the Flag cell so the row handler opens the detail.
    await row.getByRole('cell').nth(1).click();
    await expect(page.getByTestId('flag-detail')).toBeVisible();
    await page.getByTestId('flag-accept').click();
    await expect(page.getByText('Flag confirmed')).toBeVisible();

    await page.goto('/ai/forecast');
    await expect(page.getByTestId('forecast-row')).toHaveCount(6);
  });
});
