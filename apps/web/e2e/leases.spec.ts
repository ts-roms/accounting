import { expect, test } from './fixtures';
import { login } from './helpers';

/**
 * Prompt #13 - Lease accounting. Runs against the seeded development stack
 * (ACME: an active head-office finance lease with four runs posted, a
 * short-term forklift rental, a draft van hire). Creating a lease and
 * commencing it produces a fresh document each pass, so the seed is never
 * mutated; reports and runs pages are read-only checks.
 */
test.describe('leases', () => {
  test.slow();

  test('list shows the seeded leases and the detail page shows the schedule and carrying amounts', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/leases');
    await expect(page.getByRole('heading', { name: 'Leases' })).toBeVisible();
    await expect(page.getByText('Head office - 3F Butuan Commerce Center')).toBeVisible({
      timeout: 45_000,
    });
    await page.getByText('Head office - 3F Butuan Commerce Center').click();
    await expect(page.getByText('Lease liability')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('lease-liability')).toContainText('1,301,521.39');
    await expect(page.getByTestId('lease-line')).toHaveCount(36, { timeout: 45_000 });
    await expect(page.getByTestId('lease-event').first()).toBeVisible();
  });

  test('a new lease previews its schedule, is saved as a draft and commences (exempt: schedule only)', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/leases');
    await page.getByTestId('lease-new').click();
    await page.getByTestId('lease-name').fill(`Playwright storage unit ${Date.now()}`);
    // Six months: short-term exemption, so no lessor is needed to commence.
    await page.getByTestId('lease-term').fill('6');
    await page.getByTestId('lease-payment').fill('6000');
    await page.getByTestId('lease-preview').click();
    await expect(page.getByTestId('lease-preview-table')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Liability at commencement')).toBeVisible();
    await page.getByTestId('lease-save').click();
    await expect(page.getByTestId('lease-commence')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole('heading', { name: 'Not yet commenced' })).toBeVisible();
    await page.getByTestId('lease-commence').click();
    await page.getByTestId('lease-action-confirm').click();
    await expect(page.getByTestId('lease-line')).toHaveCount(6, { timeout: 45_000 });
    await expect(page.getByTestId('lease-pay')).toBeVisible();
    await expect(page.getByText('Short-term (exempt)').first()).toBeVisible();
  });

  test('runs page lists the posted runs with the policy card; reports show the register, maturity and integrity', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/leases/runs');
    await expect(page.getByRole('heading', { name: 'Lease Runs' })).toBeVisible();
    await expect(page.getByText('LRN-2026-000001')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('lease-auto-post')).toBeVisible();
    await page.getByText('LRN-2026-000004').click();
    await expect(page.getByText('Reverse this run')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await page.goto('/leases/reports');
    await expect(page.getByRole('heading', { name: 'Lease Reports' })).toBeVisible();
    await expect(page.getByTestId('lease-register-row').first()).toBeVisible({ timeout: 45_000 });
    await page.getByRole('tab', { name: 'Maturity' }).click();
    await expect(page.getByTestId('lease-maturity-row').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await expect(page.getByTestId('lease-integrity-row')).toHaveCount(5, { timeout: 30_000 });
    await expect(page.getByText('LEASE_LIABILITY_VS_LEDGER')).toBeVisible();
    await page.goto('/fixed-assets/rollforward');
    await expect(page.getByRole('heading', { name: 'Asset Register Rollforward' })).toBeVisible();
    await expect(page.getByText('Right-of-use assets (leases)').first()).toBeVisible({
      timeout: 45_000,
    });
  });
});
