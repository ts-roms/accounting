// Load test against a running API: N virtual users each replaying the dashboard page (17
// calls, 6 at a time like a browser) or a mixed navigation session, for D seconds. Prints
// throughput, page-load percentiles, per-endpoint percentiles + errors by status, the API's
// Postgres connection usage and - when Postgres and the API run on this machine - where the
// CPU went (Postgres backends vs the Node process). Needs the seeded admin user; raise the rate
// limits (AUTH_LOGIN_RATE_LIMIT / RATE_LIMIT_MAX) on the API under test.
//
//   node infrastructure/scripts/load-test.mjs http://127.0.0.1:3001/api/v1 10 30 dashboard
//   node infrastructure/scripts/load-test.mjs http://127.0.0.1:3001/api/v1 10 30 mixed
//
// Load model (env):
//   RAMP=s        start users evenly over s seconds (default 0); samples taken during the ramp
//                 are dropped from the percentiles
//   THINK_MS=n    pause n ms (+-50 %) between a user's pages (default 0 = back to back, the
//                 original closed loop: it measures capacity, not what people do)
//   RATE=r        OPEN loop instead: r page loads per second arrive (Poisson) whatever the
//                 latency - queueing shows up as latency instead of being hidden by fewer
//                 requests (USERS then only caps concurrency)
//   TODAY=date    business date for the as-of parameters (default: today)
// Measurement (env):
//   PG_CONTAINER / PG_DATABASE select where pg_stat_activity is sampled (accounting-postgres /
//   accounting); PG_LOCAL=1 samples with local psql instead of docker exec (PG_URL).
//   API_PID=pid   the API process for the CPU split (default: the node process listening on the
//                 base URL's port, found through /proc); Postgres backends are found by name.
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:3013/api/v1';
const USERS = Number(process.argv[3] ?? 10);
const SECONDS = Number(process.argv[4] ?? 30);
const SCENARIO = process.argv[5] ?? 'dashboard';
const RAMP = Number(process.env.RAMP ?? 0);
const THINK_MS = Number(process.env.THINK_MS ?? 0);
const RATE = process.env.RATE ? Number(process.env.RATE) : null;
const H = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
const today = process.env.TODAY ?? new Date().toISOString().slice(0, 10);
// End of the previous month, as the dashboard computes it (not a hard-coded date).
const lastMonthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0))
  .toISOString()
  .slice(0, 10);

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
  const cid = companies.find((c) => c.code === (process.env.COMPANY ?? 'ACME')).id;
  return { ...H, cookie, 'x-company-id': cid };
}

// apps/web/app/(app)/dashboard/page.tsx and the cards it renders (17 calls for a user holding
// every permission).
const dashboard = [
  '/auth/me',
  '/notifications/unread-count',
  '/notifications?pageSize=20&unreadOnly=false',
  '/integrity/runs/latest',
  `/reconciliations/summary?asOf=${today}`,
  '/financial-closes?page=1&pageSize=1&sortBy=createdAt&sortDir=desc',
  `/reports/income-statement/trend?to=${today}&months=6`,
  `/reports/balance-sheet?asOf=${today}`,
  `/reports/balance-sheet?asOf=${lastMonthEnd}`,
  '/journal-entries?page=1&pageSize=1&status=SUBMITTED',
  `/reports/ar-aging?asOf=${today}`,
  `/reports/ap-aging?asOf=${today}`,
  '/users?page=1&pageSize=1',
  '/roles',
  '/companies',
  '/audit-logs?page=1&pageSize=6',
  '/approvals?mine=true&page=1&pageSize=5',
];
const pages = {
  dashboard: [dashboard],
  mixed: [
    dashboard,
    ['/auth/me', '/journal-entries?page=1&pageSize=25'],
    ['/auth/me', '/invoices?page=1&pageSize=25'],
    ['/auth/me', `/reports/trial-balance?from=${today.slice(0, 4)}-01-01&to=${today}`],
    ['/auth/me', `/treasury/dashboard?asOf=${today}`],
    ['/auth/me', `/controls/dashboard?asOf=${today}`],
    ['/auth/me', '/bills?page=1&pageSize=25', '/accounts'],
    ['/auth/me', `/reports/income-statement?from=${today.slice(0, 8)}01&to=${today}`],
  ],
  // mixed without the live-audit page: what the navigation costs when /controls/dashboard is
  // not in the mix (it runs the whole integrity audit per visit).
  'mixed-no-controls': null,
};
pages['mixed-no-controls'] = pages.mixed.filter((p) => !p.some((x) => x.startsWith('/controls')));

const samples = new Map(); // path -> ms[]
const statuses = new Map(); // path -> Map<status, n>
let errors = 0;
let requests = 0;
let pageLoads = 0;
const pageTimes = [];
const errorSamples = [];
let measuring = RAMP === 0;

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
  let status = 0;
  try {
    const r = await fetch(base + path, { headers });
    await r.arrayBuffer();
    status = r.status;
  } catch (e) {
    if (errorSamples.length < 5) errorSamples.push(`${e.code ?? e.message} ${path}`);
  }
  if (!measuring) return;
  const ms = performance.now() - t;
  requests += 1;
  if (status !== 200) {
    errors += 1;
    if (status && errorSamples.length < 5) errorSamples.push(`${status} ${path}`);
  }
  if (!samples.has(key)) samples.set(key, []);
  samples.get(key).push(ms);
  const s = statuses.get(key) ?? new Map();
  s.set(status, (s.get(status) ?? 0) + 1);
  statuses.set(key, s);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function pgActive() {
  try {
    const sql = `select count(*) filter (where state='active'), count(*) from pg_stat_activity where application_name='accounting-api'`;
    const cmd = process.env.PG_LOCAL
      ? `psql "${process.env.PG_URL ?? 'postgres://accounting:accounting@127.0.0.1:5433/accounting'}" -Atc "${sql}"`
      : `docker exec ${process.env.PG_CONTAINER ?? 'accounting-postgres'} psql -U accounting -d ${process.env.PG_DATABASE ?? 'accounting'} -Atc "${sql}"`;
    return execSync(cmd).toString().trim();
  } catch {
    return '?';
  }
}

// CPU split from /proc (Linux, same machine). Parallel query workers are short-lived
// processes, so summing live postgres processes undercounts; instead take machine-wide busy
// time from /proc/stat and subtract the API process and this load generator.
function cpuJiffies() {
  let api = 0;
  const apiPid = process.env.API_PID ?? null;
  try {
    const [, ...f] = readFileSync('/proc/stat', 'utf8')
      .split('\n')[0]
      .trim()
      .split(/\s+/)
      .map(Number);
    const busy = f[0] + f[1] + f[2] + f[5] + f[6] + f[7]; // user nice system irq softirq steal
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      let stat;
      let cmd;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      } catch {
        continue;
      }
      if (apiPid ? pid !== String(apiPid) : !cmd.includes('dist/main.js')) continue;
      const g = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      api += Number(g[11]) + Number(g[12]);
    }
    const u = process.cpuUsage();
    return { busy, api, self: (u.user + u.system) / 10_000 };
  } catch {
    return null;
  }
}

const headers = await Promise.all(
  Array.from({ length: USERS }, (_, i) => session(LOGINS[i % LOGINS.length])),
);
const deadline = Date.now() + (SECONDS + RAMP) * 1000;
const pgSamples = [];
const monitor = setInterval(() => pgSamples.push(pgActive()), 5000);
let cpu0 = null;
let measureStart = performance.now();
const startMeasuring = () => {
  measuring = true;
  cpu0 = cpuJiffies();
  measureStart = performance.now();
};
if (RAMP > 0) setTimeout(startMeasuring, RAMP * 1000);
else startMeasuring();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function loadPage(h, page) {
  const t = performance.now();
  await pool(page, 6, (p) => hit(h, p));
  if (measuring) {
    pageTimes.push(performance.now() - t);
    pageLoads += 1;
  }
}

async function user(h, index) {
  if (RAMP > 0) await sleep((RAMP * 1000 * index) / USERS);
  const list = pages[SCENARIO];
  let n = 0;
  while (Date.now() < deadline) {
    await loadPage(h, list[n++ % list.length]);
    if (THINK_MS > 0) await sleep(THINK_MS * (0.5 + Math.random()));
  }
}

async function openLoop() {
  // Poisson arrivals at RATE pages/s; at most USERS pages in flight (the rest queue client-side
  // and their wait counts in the page time, as a browser's would).
  const list = pages[SCENARIO];
  let inFlight = 0;
  let n = 0;
  const waiting = [];
  const running = [];
  while (Date.now() < deadline) {
    await sleep(-Math.log(1 - Math.random()) * (1000 / RATE));
    const h = headers[n % headers.length];
    const page = list[n++ % list.length];
    const queuedAt = performance.now();
    const go = async () => {
      inFlight += 1;
      await pool(page, 6, (p) => hit(h, p));
      if (measuring) {
        pageTimes.push(performance.now() - queuedAt);
        pageLoads += 1;
      }
      inFlight -= 1;
      const next = waiting.shift();
      if (next) running.push(next());
    };
    if (inFlight < USERS) running.push(go());
    else waiting.push(go);
  }
  await Promise.all(running);
}

if (RATE) await openLoop();
else await Promise.all(headers.map((h, i) => user(h, i)));
clearInterval(monitor);
const elapsed = (performance.now() - measureStart) / 1000;
const cpu1 = cpuJiffies();

console.log(
  `scenario=${SCENARIO} ${RATE ? `open-loop rate=${RATE}/s max-in-flight=${USERS}` : `users=${USERS}`} ramp=${RAMP}s think=${THINK_MS}ms measured=${elapsed.toFixed(0)}s requests=${requests} (${(requests / elapsed).toFixed(1)} req/s) pages=${pageLoads} (${(pageLoads / elapsed).toFixed(2)} pages/s) errors=${errors}`,
);
console.log(
  `page load ms: p50=${pct(pageTimes, 50).toFixed(0)} p95=${pct(pageTimes, 95).toFixed(0)} p99=${pct(pageTimes, 99).toFixed(0)} max=${Math.max(...pageTimes).toFixed(0)}`,
);
if (cpu0 && cpu1) {
  const hz = 100; // USER_HZ on Linux
  const cores = (j) => (j / hz / elapsed).toFixed(2);
  const machine = cpu1.busy - cpu0.busy;
  const api = cpu1.api - cpu0.api;
  const self = cpu1.self - cpu0.self;
  console.log(
    `cpu (cores busy, avg; ${readFileSync('/proc/cpuinfo', 'utf8').match(/^processor/gm)?.length ?? '?'} cores): machine=${cores(machine)} api(node)=${cores(api)} load-generator=${cores(self)} postgres+rest~=${cores(machine - api - self)}  loadavg=${readFileSync('/proc/loadavg', 'utf8').split(' ')[0]}`,
  );
}
console.log(`pg active/total connections (5 s samples): ${pgSamples.join(' ')}`);
if (errorSamples.length) console.log('errors:', errorSamples.join(' | '));
const rows = [...samples.entries()]
  .map(([k, v]) => ({
    k,
    n: v.length,
    p50: pct(v, 50),
    p95: pct(v, 95),
    p99: pct(v, 99),
    max: Math.max(...v),
    st: [...(statuses.get(k) ?? new Map()).entries()]
      .filter(([s]) => s !== 200)
      .map(([s, c]) => `${s || 'net'}x${c}`)
      .join(' '),
  }))
  .sort((a, b) => b.p95 - a.p95);
for (const r of rows)
  console.log(
    String(r.n).padStart(6),
    'p50',
    String(r.p50.toFixed(0)).padStart(5),
    'p95',
    String(r.p95.toFixed(0)).padStart(5),
    'p99',
    String(r.p99.toFixed(0)).padStart(5),
    'max',
    String(r.max.toFixed(0)).padStart(6),
    r.k,
    r.st ? ` errors: ${r.st}` : '',
  );
