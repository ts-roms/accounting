import { expect, test, type Page } from '@playwright/test';
import { FINANCE, login } from './helpers';

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

/** Calls the API through the page's cookie jar with the active company header. */
async function apiCall(page: Page, method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const me = await page.request.get('/api/v1/auth/me');
  const companyId = (await me.json()).companies[0].id as string;
  const headers = { 'x-requested-with': 'XMLHttpRequest', 'x-company-id': companyId };
  const res = await page.request[method](`/api/v1${path}`, { data, headers });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeTruthy();
  return res;
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
    await expect(page.getByTestId('integrity-check')).toHaveCount(16);
    await expect(page.getByText('Posted journals balance')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'UNBALANCED_JOURNAL' })).toContainText(
      'PASS',
    );
    await expect(page.getByRole('row').filter({ hasText: 'AR_CONTROL_VARIANCE' })).toContainText(
      'PASS',
    );
  });
});

test.describe('reconciliation center', () => {
  test.slow();

  test('runs an area, logs and resolves an exception, and a second user approves', async ({
    page,
  }) => {
    await login(page);
    // An approved reconciliation is final, so pick a day that has none yet (re-runs).
    const taken = new Set(
      (
        (
          await (
            await apiCall(page, 'get', '/reconciliations?area=AP&status=APPROVED&pageSize=200')
          ).json()
        ).items as { asOf: string }[]
      ).map((r) => r.asOf),
    );
    const day = new Date();
    while (taken.has(day.toISOString().slice(0, 10))) day.setDate(day.getDate() - 1);
    const asOf = day.toISOString().slice(0, 10);
    await page.goto('/accounting/reconciliation');
    await page.getByTestId('recon-asof').fill(asOf);
    await expect(page.getByTestId('recon-tile')).toHaveCount(5);
    await expect(page.getByTestId('bank-tile').first()).toBeVisible();
    // Run accounts payable as admin (the preparer).
    const ap = page.getByTestId('recon-tile').filter({ hasText: 'Accounts payable' });
    await ap.getByTestId('recon-run').click();
    await expect(page).toHaveURL(/\/accounting\/reconciliation\/[0-9a-f-]+$/);
    await expect(page.getByTestId('recon-status')).toHaveText('RECONCILED');
    await expect(page.getByTestId('recon-line').first()).toBeVisible();
    // The preparer never sees Approve.
    await expect(page.getByTestId('recon-approve')).toHaveCount(0);
    // Log an exception and resolve it.
    await page.getByTestId('recon-add-exception').click();
    await page.getByTestId('exc-description').fill('Timing: payment cleared next day');
    await page.getByTestId('exc-amount').fill('0');
    await page.getByTestId('exc-save').click();
    await expect(page.getByTestId('recon-exception')).toHaveCount(1);
    await page.getByTestId('recon-resolve').click();
    await page.getByTestId('exc-resolution').fill('Cleared on the following statement');
    await page.getByTestId('exc-resolve-confirm').click();
    await expect(page.getByTestId('recon-exception')).toContainText('RESOLVED');
    const url = page.url();
    // Finance approves.
    await login(page, FINANCE);
    await page.goto(url);
    await page.getByTestId('recon-approve').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('recon-status')).toHaveText('APPROVED');
    await expect(page.getByTestId('recon-recompute')).toHaveCount(0);
  });
});

test.describe('financial close', () => {
  test.slow();

  test('a close is started, evaluated, worked, approved by finance and completed', async ({
    page,
  }) => {
    // Periods close in sequence, so the earliest open period is the one to close.
    await login(page);
    const years = (await (await apiCall(page, 'get', '/fiscal-years')).json()) as Array<{
      periods: Array<{ id: string; name: string; endDate: string; status: string }>;
    }>;
    const period = years
      .flatMap((y) => y.periods)
      .filter((p) => p.status === 'OPEN')
      .sort((a, b) => a.endDate.localeCompare(b.endDate))[0];
    const asOf = period.endDate;
    // A live close left behind by an interrupted run would make the start a duplicate.
    const closes = await apiCall(page, 'get', '/financial-closes?pageSize=100');
    for (const c of (await closes.json()).items as {
      id: string;
      fiscalPeriodId: string;
      status: string;
    }[]) {
      if (c.fiscalPeriodId === period.id && !['COMPLETED', 'CANCELLED'].includes(c.status))
        await apiCall(page, 'post', `/financial-closes/${c.id}/cancel`, {
          reason: 'Playwright reset',
        });
    }
    // Prepare as admin, approve as finance (four-eyes) every subledger reconciliation for the period
    // (an approved one from an earlier run is final and already satisfies the check).
    const existing = await apiCall(
      page,
      'get',
      `/reconciliations?from=${asOf}&to=${asOf}&pageSize=50`,
    );
    const approved = new Set(
      ((await existing.json()).items as { area: string; status: string }[])
        .filter((r) => r.status === 'APPROVED')
        .map((r) => r.area),
    );
    for (const area of ['AR', 'AP', 'INVENTORY', 'FIXED_ASSETS', 'TAX']) {
      if (!approved.has(area)) await apiCall(page, 'post', '/reconciliations', { area, asOf });
    }
    await apiCall(page, 'patch', '/accounting-policies', {
      closeRequireBankReconciliation: false,
      closeRequireDepreciation: false,
    });
    await login(page, FINANCE);
    const list = await apiCall(page, 'get', `/reconciliations?from=${asOf}&to=${asOf}&pageSize=50`);
    for (const r of (await list.json()).items as { id: string; status: string }[]) {
      if (r.status !== 'APPROVED')
        await apiCall(page, 'post', `/reconciliations/${r.id}/approve`, {});
    }
    await login(page);

    await page.goto('/accounting/financial-close');
    await page.getByTestId('close-start').click();
    await page.getByTestId('close-period').click();
    await page.getByRole('option', { name: period.name }).click();
    await page.getByTestId('close-start-confirm').click();
    await expect(page).toHaveURL(/\/accounting\/financial-close\/[0-9a-f-]+$/);
    await expect(page.getByTestId('close-status')).toHaveText('IN PROGRESS');
    await expect(page.getByTestId('close-task')).toHaveCount(18);

    // Work every required manual task.
    for (const key of [
      'MANUAL_ACCRUALS',
      'MANUAL_PREPAYMENTS',
      'MANUAL_SUSPENSE',
      'MANUAL_STATEMENT_REVIEW',
    ]) {
      await page
        .locator(`[data-testid="close-task"][data-key="${key}"]`)
        .getByTestId('close-task-edit')
        .click();
      await page.getByTestId('task-status').click();
      await page.getByRole('option', { name: 'DONE', exact: true }).click();
      await page.getByTestId('task-notes').fill('Reviewed');
      await page.getByTestId('task-save').click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await expect(page.getByTestId('close-status')).toHaveText('READY');

    const url = page.url();
    await login(page, FINANCE);
    await page.goto(url);
    await page.getByTestId('close-approve').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('close-status')).toHaveText('APPROVED');
    await page.getByTestId('close-complete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Close period' }).click();
    await expect(page.getByTestId('close-status')).toHaveText('COMPLETED');

    // Leave the period open for the rest of the suite (and re-runs).
    await login(page);
    await apiCall(page, 'post', `/fiscal-periods/${period.id}/reopen`, {
      reason: 'Playwright suite cleanup',
    });
  });
});
