import { expect, type BrowserContext, type Page } from '@playwright/test';

export const ADMIN = { email: 'admin@acme.local', password: 'Admin!Passw0rd' };
export const FINANCE = { email: 'finance@acme.local', password: 'Demo!Passw0rd' };

/** Contexts that switched away from the shared admin storage state. */
const switched = new WeakSet<BrowserContext>();

/**
 * Establishes a session by calling the login API through the page's request
 * context (which shares cookies with the browser). The admin session is
 * normally already present via the `setup` project's storage state, so most
 * tests never hit `/auth/login` at all - well under the API's login throttle.
 *
 * Never sign the shared admin session out through the UI: every test reuses
 * its refresh token, and a revoked token trips the reuse detector, which
 * revokes every session of the user. Switching users only clears cookies.
 */
export async function login(page: Page, creds = ADMIN) {
  const context = page.context();
  if (creds === ADMIN && !switched.has(context)) {
    await page.goto('/dashboard');
    if (/\/dashboard/.test(page.url())) return;
  }
  await context.clearCookies();
  if (creds === ADMIN) switched.delete(context);
  else switched.add(context);
  await apiLogin(page, creds);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function apiLogin(page: Page, creds: { email: string; password: string }) {
  const res = await page.request.post('/api/v1/auth/login', {
    data: creds,
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  });
  expect(res.status(), `login as ${creds.email}`).toBe(200);
}
