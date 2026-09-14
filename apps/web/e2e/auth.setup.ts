import { expect, test as setup } from '@playwright/test';
import { ADMIN, apiLogin } from './helpers';

export const ADMIN_STATE = 'e2e/.auth/admin.json';

/** One real admin login per run; every test starts from this stored session. */
setup('authenticate as admin', async ({ page }) => {
  await page.context().clearCookies();
  await apiLogin(page, ADMIN);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: ADMIN_STATE });
});
