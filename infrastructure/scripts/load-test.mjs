// Closed-loop load test against a running API: N virtual users each replaying the dashboard
// page (16 calls, 6 at a time like a browser) or a mixed navigation session, back to back,
// for D seconds. Prints throughput, page-load percentiles, per-endpoint percentiles and the
// API's Postgres connection usage. Needs the seeded admin user; raise the rate limits
// (AUTH_LOGIN_RATE_LIMIT / RATE_LIMIT_MAX) on the API under test.
//
//   node infrastructure/scripts/load-test.mjs http://127.0.0.1:3001/api/v1 10 30 dashboard
//   node infrastructure/scripts/load-test.mjs http://127.0.0.1:3001/api/v1 10 30 mixed
//
// PG_CONTAINER / PG_DATABASE select where pg_stat_activity is sampled (accounting-postgres / accounting).
import { execSync } from 'node:child_process';

const base = process.argv[2] ?? 'http://127.0.0.1:3013/api/v1';
const USERS = Number(process.argv[3] ?? 10);
const SECONDS = Number(process.argv[4] ?? 30);
const SCENARIO = process.argv[5] ?? 'dashboard';
const H = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
const today = new Date().toISOString().slice(0, 10);

const LOGINS = ['admin@acme.local'];

async function session(email) {
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ email, password: 'P@ssw0rd123' }),
  });
  if (login.status !== 200) throw new Error('login ' + login.status + ' ' + (await login.text()));
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const companies = await fetch(base + '/companies', { headers: { ...H, cookie } }).then((r) =>
    r.json(),
  );
  const cid = companies.find((c) => c.code === 'ACME').id;
  return { ...H, cookie, 'x-company-id': cid };
}

const dashboard = [
  '/auth/me',
  '/notifications/unread-count',
  '/notifications?pageSize=20&unreadOnly=false',
  '/integrity/runs/latest',
  `/reconciliations/summary?asOf=${today}`,
  '/financial-closes?page=1&pageSize=1&sortBy=createdAt&sortDir=desc',
  `/reports/income-statement/trend?to=${today}&months=6`,
  `/reports/balance-sheet?asOf=${today}`,
  '/reports/balance-sheet?asOf=2026-08-31',
  '/journal-entries?page=1&pageSize=1&status=SUBMITTED',
  `/reports/ar-aging?asOf=${today}`,
  `/reports/ap-aging?asOf=${today}`,
  '/users?page=1&pageSize=1',
  '/roles',
  '/companies',
  '/audit-logs?page=1&pageSize=6',
];
const pages = {
  dashboard: [dashboard],
  mixed: [
    dashboard,
    ['/auth/me', '/journal-entries?page=1&pageSize=25'],
    ['/auth/me', '/invoices?page=1&pageSize=25'],
    ['/auth/me', '/reports/trial-balance?from=2026-01-01&to=2026-09-30'],
    ['/auth/me', `/treasury/dashboard?asOf=${today}`],
    ['/auth/me', `/controls/dashboard?asOf=${today}`],
    ['/auth/me', '/bills?page=1&pageSize=25', '/accounts'],
    ['/auth/me', '/reports/income-statement?from=2026-09-01&to=2026-09-30'],
  ],
};

const samples = new Map(); // path -> ms[]
let errors = 0;
let requests = 0;
let pageLoads = 0;
const pageTimes = [];
const errorSamples = [];

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
      }
    }),
  );
}

async function hit(headers, path) {
  const key = path.split('?')[0];
  const t = performance.now();
  try {
    const r = await fetch(base + path, { headers });
    await r.arrayBuffer();
    const ms = performance.now() - t;
    requests += 1;
    if (r.status !== 200) {
      errors += 1;
      if (errorSamples.length < 5) errorSamples.push(`${r.status} ${path}`);
    }
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key).push(ms);
  } catch (e) {
    errors += 1;
    requests += 1;
    if (errorSamples.length < 5) errorSamples.push(`${e.code ?? e.message} ${path}`);
  }
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function pgActive() {
  try {
    const out = execSync(
      `docker exec ${process.env.PG_CONTAINER ?? 'accounting-postgres'} psql -U accounting -d ${process.env.PG_DATABASE ?? 'accounting'} -Atc "select count(*) filter (where state='active'), count(*) from pg_stat_activity where application_name='accounting-api'"`,
    ).toString();
    return out.trim();
  } catch {
    return '?';
  }
}

const headers = await Promise.all(
  Array.from({ length: USERS }, (_, i) => session(LOGINS[i % LOGINS.length])),
);
const deadline = Date.now() + SECONDS * 1000;
const pgSamples = [];
const monitor = setInterval(() => pgSamples.push(pgActive()), 5000);

async function user(h) {
  const list = pages[SCENARIO];
  let n = 0;
  while (Date.now() < deadline) {
    const page = list[n++ % list.length];
    const t = performance.now();
    await pool(page, 6, (p) => hit(h, p));
    pageTimes.push(performance.now() - t);
    pageLoads += 1;
  }
}

const start = performance.now();
await Promise.all(headers.map(user));
clearInterval(monitor);
const elapsed = (performance.now() - start) / 1000;

console.log(
  `scenario=${SCENARIO} users=${USERS} duration=${elapsed.toFixed(0)}s requests=${requests} (${(requests / elapsed).toFixed(1)} req/s) pages=${pageLoads} (${(pageLoads / elapsed).toFixed(2)} pages/s) errors=${errors}`,
);
console.log(
  `page load ms: p50=${pct(pageTimes, 50).toFixed(0)} p95=${pct(pageTimes, 95).toFixed(0)} p99=${pct(pageTimes, 99).toFixed(0)} max=${Math.max(...pageTimes).toFixed(0)}`,
);
console.log(`pg active/total connections (5 s samples): ${pgSamples.join(' ')}`);
if (errorSamples.length) console.log('errors:', errorSamples.join(' | '));
const rows = [...samples.entries()]
  .map(([k, v]) => ({ k, n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v) }))
  .sort((a, b) => b.p95 - a.p95);
for (const r of rows)
  console.log(
    String(r.n).padStart(6),
    'p50',
    String(r.p50.toFixed(0)).padStart(5),
    'p95',
    String(r.p95.toFixed(0)).padStart(5),
    'max',
    String(r.max.toFixed(0)).padStart(6),
    r.k,
  );
