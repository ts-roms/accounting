import { expect, test } from '@playwright/test';
import { login } from './helpers';

/** Hardening H8: the operations console - runtime status, jobs, run history, queues, integrity runs. */
test.describe('operations console', () => {
  test.slow();

  test('shows runtime health, runs a job manually and records it in the run history', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/operations');
    const status = page.getByTestId('ops-status');
    await expect(status).toBeVisible();
    await expect(status.getByTestId('ops-migrations')).toHaveText('Current');
    await expect(status.getByTestId('ops-storage')).toHaveText('Writable');
    await expect(status.getByTestId('ops-db')).toContainText('ms');

    const job = page.locator('[data-testid="ops-job"][data-name="session-cleanup"]');
    await expect(job).toBeVisible();
    await expect(job).toContainText('0 3 * * *');
    await job.getByTestId('ops-run').click();
    await expect(page.getByText(/session-cleanup: SUCCEEDED/)).toBeVisible();
    await expect(job).toContainText('SUCCEEDED');
    await expect(job).toContainText('manual');

    await page.getByTestId('ops-tab-runs').click();
    await page.getByTestId('ops-runs-job').click();
    await page.getByRole('option', { name: 'session-cleanup' }).click();
    const rows = page.getByTestId('ops-run-row');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText('manual');
    await expect(rows.first()).toContainText('SUCCEEDED');
    await expect(rows.first()).toContainText('deleted');
  });

  test('lists queues with their schedulers and the selected queue dead letter', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/operations');
    await page.getByTestId('ops-tab-queues').click();
    const queues = page.getByTestId('ops-queue');
    await expect(queues.first()).toBeVisible();
    const maintenance = page.locator('[data-testid="ops-queue"][data-name="maintenance"]');
    await expect(maintenance).toContainText(/\d+ schedulers?/);
    await maintenance.click();
    await expect(maintenance).toHaveAttribute('data-state', 'selected');
    await expect(page.getByText(/Dead letter · maintenance/)).toBeVisible();
    await expect(page.getByText(/No failed jobs|Retry all/).first()).toBeVisible();
  });

  test('runs an integrity check for the active company and lists the stored outcome', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/operations');
    await page.getByTestId('ops-tab-integrity').click();
    await page.getByTestId('ops-integrity-run').click();
    await expect(page.getByText(/Integrity check (OK|WARNING|CRITICAL) for ACME/)).toBeVisible();
    const row = page.getByTestId('ops-integrity-row').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('ACME');
    await expect(row).toContainText(/OK|WARNING|CRITICAL/);
  });
});
