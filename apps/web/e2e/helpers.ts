import { expect, type BrowserContext, type Page } from '@playwright/test';

export const ADMIN = { email: 'admin@acme.local', password: 'P@ssw0rd123' };
export const FINANCE = { email: 'finance@acme.local', password: 'P@ssw0rd123' };

/** Storage state written by the `setup` project and re-persisted after every admin test (see fixtures.ts). */
export const ADMIN_STATE = 'e2e/.auth/admin.json';

/** Contexts that switched away from the shared admin storage state. */
const switched = new WeakSet<BrowserContext>();

export const isAdminContext = (context: BrowserContext): boolean => !switched.has(context);

/** Either the signed-in app shell or the login form - whichever the session provider lands on. */
const SHELL_OR_LOGIN = 'nav[aria-label="Main navigation"], form input[type="password"]';

/**
 * Waits for the app to settle after a navigation: the session provider first
 * renders a fallback, then either the shell (valid session) or redirects to
 * /login (401 on /auth/me). Returning before that decision is what made tests
 * proceed on a page that was about to be swapped for the login form.
 */
export async function settle(page: Page): Promise<'shell' | 'login'> {
  const target = page.locator(SHELL_OR_LOGIN).first();
  // The dev server occasionally stalls the page's first API call while it compiles; a reload
  // after 20 s clears that far more reliably than waiting out the whole budget.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await target.waitFor({ state: 'visible', timeout: attempt < 2 ? 20_000 : 60_000 });
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await page.reload({ waitUntil: 'commit' });
    }
  }
  return /\/login/.test(page.url()) ? 'login' : 'shell';
}

/**
 * Establishes a session by calling the login API through the page's request
 * context (which shares cookies with the browser). The admin session is
 * normally already present via the `setup` project's storage state, so most
 * tests never hit `/auth/login` at all - well under the API's login throttle.
 *
 * The refresh token in that state rotates whenever a test's page refreshes
 * (access token expiry in a long run, or a stray 401); presenting the old one
 * from the next test's context trips the API's reuse detector, which revokes
 * every session of the user. Two things keep the suite healthy: the fixtures
 * write the context's cookies back to the state file after each admin test
 * (so the next context starts from the rotated token), and this helper is
 * self-healing - if the stored session is gone it simply logs in again.
 *
 * Never sign the shared admin session out through the UI. Switching users
 * only clears cookies - after leaving the app page, so that no in-flight
 * request of the previous user can fail its refresh and clear the freshly set
 * cookies (a 401 refresh response carries cookie-clearing headers).
 */
export async function login(page: Page, creds = ADMIN) {
  const context = page.context();
  if (creds === ADMIN && !switched.has(context)) {
    await page.goto('/dashboard');
    if ((await settle(page)) === 'shell') return;
    // Stored session rejected (revoked or expired): fall through and log in again.
  }
  await page.goto('about:blank');
  await context.clearCookies();
  if (creds === ADMIN) switched.delete(context);
  else switched.add(context);
  await apiLogin(page, creds);
  await page.goto('/dashboard');
  expect(await settle(page)).toBe('shell');
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function apiLogin(page: Page, creds: { email: string; password: string }) {
  const res = await page.request.post('/api/v1/auth/login', {
    data: creds,
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  });
  expect(res.status(), `login as ${creds.email}`).toBe(200);
}
