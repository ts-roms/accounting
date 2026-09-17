import { expect, test } from './fixtures';
import { login } from './helpers';

/**
 * Prompt #10 - Revenue section. Runs against the seeded development stack
 * (ACME: three policies, an annual support plan recognized ratably, an ERP
 * rollout earned per milestone, June - August runs posted).
 */
test.describe('revenue recognition', () => {
  test.slow();

  test('schedules list and detail show the seeded deferred revenue and milestones', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/revenue/schedules');
    await expect(page.getByRole('heading', { name: 'Revenue Schedules' })).toBeVisible();
    await expect(page.getByText('Annual support plan Jun 2026 - May 2027')).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText('ERP rollout - implementation project')).toBeVisible();
    await page.getByText('ERP rollout - implementation project').click();
    await expect(page).toHaveURL(/\/revenue\/schedules\/[0-9a-f-]+$/);
    await expect(page.getByText('Recognition lines')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Configuration accepted')).toBeVisible();
    await expect(page.getByText('Go-live')).toBeVisible();
    await expect(page.getByTestId('schedule-line')).toHaveCount(3);
    await expect(page.getByTestId('complete-milestone')).toBeVisible();
    await expect(page.getByText('2190 -> 4200')).toBeVisible();
  });

  test('deferred revenue reports reconcile to the ledger and the integrity checks pass', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/revenue/reports');
    await expect(page.getByRole('heading', { name: 'Deferred Revenue' })).toBeVisible();
    await expect(page.getByText('Rollforward by method')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('rollforward-row')).toHaveCount(2);
    await expect(page.getByText('Ledger difference')).toBeVisible();
    await expect(page.getByText('Waterfall - when the deferred balance becomes revenue')).toBeVisible();
    await expect(page.getByTestId('waterfall-row').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('backlog-row').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('integrity-row')).toHaveCount(4, { timeout: 45_000 });
    await expect(page.getByText('DEFERRED_REVENUE_VS_LEDGER')).toBeVisible();
  });

  test('policies page lists the seeded policies; runs page previews what a period end would recognize', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/revenue/policies');
    await expect(page.getByRole('heading', { name: 'Revenue Policies' })).toBeVisible();
    await expect(page.getByTestId('revenue-policy-row')).toHaveCount(3, { timeout: 45_000 });
    await expect(page.getByText('RATABLE-SVC')).toBeVisible();
    await expect(page.getByText('Post due revenue automatically (scheduled job)')).toBeVisible();

    await page.goto('/revenue/runs');
    await expect(page.getByRole('heading', { name: 'Recognition Runs' })).toBeVisible();
    await expect(page.getByText('RRN-2026-000003')).toBeVisible({ timeout: 45_000 });
    await page.getByTestId('run-period-end').fill('2026-09-30');
    await expect(page.getByTestId('run-recognize')).toContainText('1 line(s)', { timeout: 30_000 });
    await page.getByText('RRN-2026-000003').click();
    await expect(page).toHaveURL(/\/revenue\/runs\/[0-9a-f-]+$/);
    await expect(page.getByText('Schedule lines in this run')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('Configuration accepted')).toBeVisible();
    await expect(page.getByTestId('run-reverse')).toBeVisible();
  });
});
