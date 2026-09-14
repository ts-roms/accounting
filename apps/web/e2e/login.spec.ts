import { expect, test } from '@playwright/test';

const ADMIN = { email: 'admin@acme.local', password: 'Admin!Passw0rd' };

test.describe('authentication', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects anonymous visitors to the login page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('rejects bad credentials with a clear message', async ({ page }) => {
    await page.goto('/login');
    // An unknown user yields the same error without consuming the admin lockout budget.
    await page.getByLabel('Email').fill('nobody@acme.local');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Invalid email or password' }),
    ).toBeVisible();
  });

  test('signs in, shows the shell and signs out', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Users' })).toBeVisible();

    await page.getByRole('link', { name: 'Users' }).click();
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.getByText(ADMIN.email)).toBeVisible();

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
