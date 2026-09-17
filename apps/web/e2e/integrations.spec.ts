import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { login } from './helpers';

const ACCOUNTANT = { email: 'accountant@acme.local', password: 'Demo!Passw0rd' };

/** Calls the API through the page's cookie jar with the active company header. */
async function apiCall(
  page: Page,
  method: 'get' | 'post' | 'delete',
  path: string,
  data?: unknown,
) {
  const me = await page.request.get('/api/v1/auth/me');
  const companyId = (await me.json()).companies[0].id as string;
  const headers = { 'x-requested-with': 'XMLHttpRequest', 'x-company-id': companyId };
  const res = await page.request[method](`/api/v1${path}`, { data, headers });
  expect(res.ok(), `${method.toUpperCase()} ${path}: ${await res.text()}`).toBeTruthy();
  return res;
}

/**
 * Prompt #4 - administration UI for the integration platform and delegated
 * authority. Runs against the seeded development stack (demo integrations
 * and DLG-000001 come from the seed).
 */
test.describe('integration platform', () => {
  test.slow();

  test('integrations page lists the seeded demo connectors and runs a sync from the detail page', async ({
    page,
  }) => {
    await login(page);
    await page.goto('/admin/integrations');
    await expect(page.getByRole('heading', { name: 'Integrations' })).toBeVisible();
    await expect(page.getByText('Demo E-Commerce', { exact: true })).toBeVisible();
    await expect(page.getByText('Demo Bank', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Available' }).click();
    await expect(page.getByTestId('provider-card').first()).toBeVisible();
    await page.getByRole('tab', { name: /^All/ }).click();
    await page.getByText('Demo E-Commerce', { exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/integrations\/[0-9a-f-]+$/);
    await expect(page.getByTestId('integration-status')).toHaveText(/Connected/);
    await page.getByTestId('integration-sync').click();
    await page.getByRole('tab', { name: 'Sync' }).click();
    await expect(page.getByTestId('sync-job').first()).toContainText(/Completed|Queued|Running/);
    await page.getByRole('tab', { name: 'Health' }).click();
    await expect(page.getByTestId('health-score')).toBeVisible();
    await page.getByRole('tab', { name: 'Logs' }).click();
    await expect(page.getByTestId('integration-log').first()).toBeVisible();
  });

  test('an API key is minted with its secret shown once, then revoked', async ({ page }) => {
    await login(page);
    await page.goto('/admin/api-keys');
    await page.getByTestId('api-key-create').click();
    const name = `Playwright key ${Date.now()}`;
    await page.getByTestId('api-key-name').fill(name);
    await page.getByTestId('scope-customers:read').click();
    await page.getByTestId('api-key-submit').click();
    const secret = await page.getByTestId('secret-value').textContent();
    expect(secret?.startsWith('ak_')).toBeTruthy();
    // The key authenticates against the API and is limited to its scope.
    const me = await (await page.request.get('/api/v1/auth/me')).json();
    const keyHeaders = { authorization: `Bearer ${secret}`, 'x-company-id': me.companies[0].id };
    const ok = await page.request.get('/api/v1/customers', { headers: keyHeaders });
    expect(ok.status()).toBe(200);
    const denied = await page.request.get('/api/v1/invoices', { headers: keyHeaders });
    expect(denied.status()).toBe(403);
    await page.getByRole('button', { name: 'I have stored it safely' }).click();
    const row = page.getByTestId('api-key-row').filter({ hasText: name });
    await row.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(row).toContainText('REVOKED');
    const revoked = await page.request.get('/api/v1/customers', { headers: keyHeaders });
    expect(revoked.status()).toBe(401);
  });

  test('a webhook subscription is created and its test delivery is recorded', async ({ page }) => {
    await login(page);
    await page.goto('/admin/webhooks');
    await page.getByTestId('webhook-create').click();
    const name = `Playwright hook ${Date.now()}`;
    await page.getByTestId('webhook-name').fill(name);
    await page.getByTestId('webhook-url').fill('http://127.0.0.1:9/unreachable');
    await page.getByRole('switch').first().click();
    await page.getByTestId('webhook-submit').click();
    await expect(page.getByTestId('secret-value')).toContainText('whsec_');
    await page.getByRole('button', { name: 'I have stored it safely' }).click();
    const row = page.getByTestId('webhook-row').filter({ hasText: name });
    await row.getByTestId('webhook-test').click();
    await page.getByRole('tab', { name: 'Deliveries' }).click();
    await expect(page.getByTestId('webhook-delivery').first()).toBeVisible();
    // Clean up so the dispatcher does not keep retrying an unreachable receiver.
    const hooks = await (await apiCall(page, 'get', '/webhooks')).json();
    const mine = hooks.find((h: { name: string }) => h.name === name);
    await apiCall(page, 'delete', `/webhooks/${mine.id}`);
  });

  test('the accountant sees the delegated-authority notice on a bill they may approve for the finance manager', async ({
    page,
  }) => {
    await login(page);
    const vendors = await (await apiCall(page, 'get', '/vendors?pageSize=1')).json();
    const accounts = await (await apiCall(page, 'get', '/accounts')).json();
    const expense = accounts.find((a: { code: string }) => a.code === '6400');
    const bill = await (
      await apiCall(page, 'post', '/bills', {
        vendorId: vendors.items[0].id,
        documentDate: '2026-09-14',
        lines: [
          { description: 'Delegated approval demo', unitPrice: '1000', accountId: expense.id },
        ],
      })
    ).json();
    await login(page, ACCOUNTANT);
    await page.goto('/admin/delegations');
    await expect(page.getByText('DLG-000001')).toBeVisible();
    await page.goto(`/purchasing/bills/${bill.id}`);
    await expect(page.getByTestId('delegated-authority-notice')).toContainText('Marco Santos');
    await expect(page.getByTestId('delegated-authority-notice')).toContainText('DLG-000001');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('APPROVED', { exact: true }).first()).toBeVisible();
  });
});
