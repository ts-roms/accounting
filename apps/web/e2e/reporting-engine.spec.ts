import { expect, test } from './fixtures';
import { login } from './helpers';

/** Hardening H7: configurable reports, the journal control center and traceability. */
test.describe('reporting engine', () => {
  test.slow();

  test('the comparative income statement runs, prints rows in layout order and drills into the ledger', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/reports/custom');
    await page.getByTestId('report-definition').click();
    await page.getByRole('option', { name: 'Income statement - comparative' }).click();
    const grid = page.getByTestId('report-grid');
    await expect(grid).toBeVisible();
    await expect(grid.locator('th', { hasText: 'Prior period' })).toBeVisible();
    await expect(grid.locator('th', { hasText: 'Variance %' })).toBeVisible();
    const keys = await grid
      .locator('[data-testid="report-row"]:not([data-kind="ACCOUNT"])')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-key')));
    expect(keys.indexOf('GROSS_PROFIT')).toBeGreaterThan(keys.indexOf('COST_OF_SALES'));
    expect(keys.indexOf('GROSS_PROFIT')).toBeLessThan(keys.indexOf('OPERATING_EXPENSES'));
    await expect(grid.locator('[data-key="NET_INCOME"]')).toBeVisible();
    // Account lines link to the general ledger for the column's window.
    const link = grid
      .locator('[data-kind="ACCOUNT"] a[href*="/accounting/general-ledger?accountId="]')
      .first();
    if ((await link.count()) > 0) {
      await link.click();
      await expect(page).toHaveURL(
        /\/accounting\/general-ledger\?accountId=.*&from=\d{4}-\d{2}-\d{2}&to=/,
      );
    }
  });

  test('a system report is copied and the copy edited with a preview; the original stays read-only', async ({
    page,
  }) => {
    await login(page);
    const stamp = Date.now().toString().slice(-6);
    await page.goto('/reports/custom');
    await page.getByTestId('report-definition').click();
    await page.getByRole('option', { name: 'Budget vs actual' }).click();
    await expect(page.getByTestId('report-grid')).toBeVisible();
    await expect(page.getByTestId('report-edit')).toHaveCount(0); // system layouts cannot be edited
    await page.getByTestId('report-copy').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByTestId('report-copy-code').fill(`PW_${stamp}`);
    await dialog.getByTestId('report-copy-name').fill(`Playwright BvA ${stamp}`);
    await dialog.getByTestId('report-copy-submit').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('report-definition')).toContainText(`Playwright BvA ${stamp}`);
    await page.getByTestId('report-edit').click();
    const editor = page.getByRole('dialog');
    const json = editor.getByTestId('report-layout-json');
    const layout = JSON.parse(await json.inputValue()) as {
      rows: Array<Record<string, unknown>>;
      columns: Array<Record<string, unknown>>;
    };
    layout.columns = [{ key: 'ACTUAL', label: 'Actual only', kind: 'CURRENT' }];
    layout.rows.push({ key: 'BAD', label: 'Broken', kind: 'FORMULA', formula: 'REVENUE - NOPE' });
    await json.fill(JSON.stringify(layout));
    await editor.getByTestId('report-layout-preview').click();
    await expect(editor.getByTestId('report-layout-error')).toContainText(/unknown row NOPE/);
    layout.rows.pop();
    await json.fill(JSON.stringify(layout));
    await editor.getByTestId('report-layout-preview').click();
    await expect(
      editor.getByTestId('report-grid').locator('th', { hasText: 'Actual only' }),
    ).toBeVisible();
    await editor.getByTestId('report-layout-save').click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByTestId('report-grid').locator('th', { hasText: 'Actual only' }),
    ).toBeVisible();
    await expect(page.getByTestId('report-grid').locator('th', { hasText: 'Budget' })).toHaveCount(
      0,
    );
  });

  test('the journal control center filters manual journals and links into the traceability panel', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/accounting/journal-control');
    await expect(page.getByTestId('jc-count')).not.toHaveText('');
    await page.getByTestId('jc-source').click();
    await page.getByRole('option', { name: 'Manual journals' }).click();
    const rows = page.locator('table tbody tr').filter({ hasText: 'JE-' });
    await expect(rows.first()).toBeVisible();
    // The summary refetches with the filter; once settled, every entry counted is manual.
    await expect
      .poll(async () => {
        const manual = await page.getByTestId('jc-manual').innerText();
        const count = await page.getByTestId('jc-count').innerText();
        return manual === count;
      })
      .toBe(true);
    await rows.first().getByRole('link', { name: /JE-/ }).click();
    await expect(page).toHaveURL(/\/accounting\/journal-entries\/[0-9a-f-]+$/);
    const trace = page.getByTestId('trace-panel');
    await expect(trace).toBeVisible();
    await expect(trace).toContainText('Manual journal - no source document.');
    await expect(trace.getByTestId('trace-posted-by')).toBeVisible();
    await expect(trace.getByRole('link', { name: /Full audit log/ })).toHaveAttribute(
      'href',
      /\/admin\/audit-logs\?entityId=/,
    );
  });
});
