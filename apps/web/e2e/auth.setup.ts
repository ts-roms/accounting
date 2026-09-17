import { expect, test as setup } from '@playwright/test';
import { ADMIN, ADMIN_STATE, apiLogin, settle } from './helpers';

/** One real admin login per run; every test starts from this stored session. */
setup('authenticate as admin', async ({ page }) => {
  await page.context().clearCookies();
  await apiLogin(page, ADMIN);
  await page.goto('/dashboard');
  // The dev server compiles the shell on first hit; wait for it rather than the bare load event.
  expect(await settle(page)).toBe('shell');
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: ADMIN_STATE });
});
