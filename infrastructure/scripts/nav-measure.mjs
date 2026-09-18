// In-page navigation timing: click a sidebar link, then measure from the
// click (capture phase) to (a) the route skeleton / new page appearing in
// <main>, (b) the last DOM mutation in <main> (settled), plus API calls.
// usage (from apps/web, where playwright is installed):
//   node ../../infrastructure/scripts/nav-measure.mjs http://127.0.0.1:3016 [rounds]
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:3016';
const rounds = Number(process.argv[3] ?? 2);
const routes = [
  '/dashboard',
  '/accounting/journal-entries',
  '/accounting/general-ledger',
  '/accounting/financial-close',
  '/sales/invoices',
  '/purchasing/bills',
  '/receivables/dashboard',
  '/payables/dashboard',
  '/reports/financial-statements',
  '/banking/feed/dashboard',
  '/treasury/dashboard',
  '/payroll/runs',
  '/leases',
  '/revenue/schedules',
  '/consolidation/runs',
  '/inventory/stock',
  '/fixed-assets/assets',
  '/admin/workflows',
  '/admin/approvals',
  '/admin/operations',
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript(() => {
  const nav = { t0: null, first: null, last: null, skeleton: null, mutations: 0 };
  window.__nav = nav;
  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('a[href]')) return;
      nav.t0 = performance.now();
      nav.first = nav.last = nav.skeleton = null;
      nav.mutations = 0;
    },
    true,
  );
  const mo = new MutationObserver((list) => {
    if (nav.t0 == null) return;
    const t = performance.now();
    for (const m of list) {
      const main = document.querySelector('main');
      if (!main || !(m.target === main || main.contains(m.target))) continue;
      if (nav.first == null) nav.first = t;
      nav.last = t;
      nav.mutations += 1;
      if (nav.skeleton == null && document.querySelector('[data-testid="route-skeleton"]'))
        nav.skeleton = t;
    }
  });
  mo.observe(document, { subtree: true, childList: true, characterData: true });
});
const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) =>
  reqs.push({ url: r.url(), type: r.resourceType(), t: performance.now() }),
);
const resps = new Map();
page.on('response', (r) => resps.set(r.url(), performance.now()));

await page.goto(base + '/login');
await page.getByPlaceholder('you@company.com').fill('admin@acme.local');
await page.getByLabel('Password').fill('P@ssw0rd123');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL(/dashboard/);
await page.waitForLoadState('networkidle');
// Expand every sidebar section once (state is kept across client navigations).
const collapsed = page.locator(
  '[data-testid="sidebar"] button[aria-expanded="false"]:not([data-testid="sidebar-toggle"])',
);
for (let i = 0; i < 20 && (await collapsed.count()) > 0; i += 1) await collapsed.first().click();

const results = {};
for (let round = 0; round < rounds; round += 1) {
  for (const route of routes) {
    await page.waitForLoadState('networkidle');
    for (let i = 0; i < 20 && (await collapsed.count()) > 0; i += 1)
      await collapsed.first().click();
    const before = reqs.length;
    const t0 = performance.now();
    await page
      .locator('[data-testid="sidebar"] a[href="' + route + '"]')
      .first()
      .click();
    await page.waitForURL((u) => u.pathname === route, { timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    // Let the page settle: no <main> mutation for 400 ms.
    await page.waitForFunction(
      () => performance.now() - (window.__nav.last ?? window.__nav.t0) > 400,
      null,
      { timeout: 30000 },
    );
    const nav = await page.evaluate(() => ({ ...window.__nav }));
    const mine = reqs.slice(before);
    const api = mine.filter((r) => r.url.includes('/api/v1/'));
    const chunks = mine.filter((r) => r.type === 'script');
    const lastApi = api.length ? Math.max(...api.map((r) => (resps.get(r.url) ?? r.t) - t0)) : 0;
    results[route] ??= [];
    results[route].push({
      round,
      first: nav.first - nav.t0,
      skeleton: nav.skeleton == null ? null : nav.skeleton - nav.t0,
      settled: nav.last - nav.t0,
      mutations: nav.mutations,
      api: api.length,
      lastApi,
      chunks: chunks.length,
      apiUrls: api.map((r) => r.url.replace(/^.*\/api\/v1/, '')),
    });
  }
}
const f = (n) => (n == null ? '-' : String(Math.round(n)));
console.log(
  'route'.padEnd(30),
  'COLD first/skel/settled  api lastApi chunks | WARM first/settled mut',
);
for (const [route, rs] of Object.entries(results)) {
  const c = rs[0];
  const w = rs[rs.length - 1];
  console.log(
    route.padEnd(30),
    `${f(c.first)}/${f(c.skeleton)}/${f(c.settled)}`.padStart(16),
    String(c.api).padStart(5),
    f(c.lastApi).padStart(7),
    String(c.chunks).padStart(6),
    ' |',
    `${f(w.first)}/${f(w.settled)}`.padStart(12),
    String(w.mutations).padStart(5),
  );
}
if (process.env.SHOW_API)
  for (const [route, rs] of Object.entries(results)) console.log(route, rs[0].apiUrls.join(' '));
await browser.close();
