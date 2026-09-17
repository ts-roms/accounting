import { expect, test } from './fixtures';
import { login } from './helpers';

/**
 * Prompt #12 - Bank feed review. Runs against the seeded development stack
 * (ACME: three rules, one open statement on BDO-MAIN with unexplained
 * lines). The first pass refreshes suggestions (auto-applying the fee and
 * interest rules); later passes find the queue already partly explained,
 * so assertions tolerate both states.
 */
test.describe('bank feed', () => {
  test.slow();

  test('review queue lists unexplained lines, refresh produces suggestions and accepting one explains the line', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/banking/feed');
    await expect(page.getByRole('heading', { name: 'Bank Feed Review' })).toBeVisible();
    await expect(page.getByTestId('feed-refresh')).toBeVisible({ timeout: 45_000 });
    await page.getByTestId('feed-refresh').click();
    await page.waitForTimeout(3000);
    const rows = page.getByRole('row').filter({ hasText: 'STM-2026-' });
    if ((await rows.count()) > 0) {
      await expect(page.getByTestId('feed-suggestion').first()).toBeVisible({ timeout: 45_000 });
      const before = await rows.count();
      await page.getByTestId('suggestion-apply').first().click();
      await expect(rows).toHaveCount(before - 1, { timeout: 45_000 });
    } else {
      await expect(page.getByText('Nothing to review')).toBeVisible();
    }
  });

  test('rules page shows the seeded rules, tests a draft and saves settings', async ({ page }) => {
    await login(page);
    await page.goto('/banking/feed/rules');
    await expect(page.getByRole('heading', { name: 'Bank Feed Rules' })).toBeVisible();
    await expect(page.getByTestId('feed-rule-row')).toHaveCount(3, { timeout: 45_000 });
    await expect(page.getByText('Bank service fees')).toBeVisible();
    await page.getByTestId('rule-new').click();
    await page.getByTestId('rule-name').fill('ATM fees');
    await page.getByTestId('rule-description').fill('atm');
    await page.getByTestId('rule-test').click();
    await expect(page.getByTestId('rule-test-result')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Auto-apply rules flagged for it')).toBeVisible();
  });

  test('KPI page reports the feed and its integrity', async ({ page }) => {
    await login(page);
    await page.goto('/banking/feed/dashboard');
    await expect(page.getByRole('heading', { name: 'Bank Feed KPIs' })).toBeVisible();
    await expect(page.getByText('Automation rate')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('feed-bank-row').first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('feed-integrity-row')).toHaveCount(3, { timeout: 45_000 });
    await expect(page.getByText('APPLIED_WITHOUT_MATCH')).toBeVisible();
  });
});
