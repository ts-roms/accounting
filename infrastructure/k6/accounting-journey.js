// k6 open-model load test: login -> dashboard -> search -> general ledger -> create journal ->
// post journal -> read the account balance. Complements infrastructure/scripts/load-test.mjs
// (local diagnosis: CPU split, pool sampling) with arrival-rate scenarios, per-endpoint
// thresholds and machine-readable output for CI trend lines.
//
//   k6 run -e BASE_URL=http://127.0.0.1:3013/api/v1 -e COMPANY=PERF03 infrastructure/k6/accounting-journey.js
//
// Safety rails - this script WRITES journals:
//   * it refuses to run unless COMPANY is a synthetic perf company (PERF01..PERF99, created by
//     infrastructure/scripts/perf-ledger.sql) or ALLOW_COMPANY=<code> names it explicitly;
//   * it refuses a non-local BASE_URL unless ALLOW_REMOTE=1 (never point it at production);
//   * credentials come from EMAIL / PASSWORD (default: the seeded development admin);
//   * it posts only to the company's PERF accounts (never a control / subledger account);
//   * every write carries an Idempotency-Key derived from RUN_ID / VU / iteration, so a k6 or
//     proxy retry can never create a second journal.
// After the run, prove the books: psql "$PERF_DB" -v since='<start>' -f infrastructure/scripts/perf-verify.sql
import http from 'k6/http';
import { check, fail, group } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3013/api/v1';
const COMPANY = __ENV.COMPANY || 'PERF03';
const TODAY = __ENV.TODAY || '2026-09-18';
const RUN_ID = __ENV.RUN_ID || `k6-${Date.now()}`;
const BROWSE_RATE = Number(__ENV.BROWSE_RATE || 2); // journeys per second at the plateau
const POST_RATE = Number(__ENV.POST_RATE || 5); // journals per second at the plateau
const DURATION = __ENV.DURATION || '10m';

if (!/^PERF\d{2}$/.test(COMPANY) && __ENV.ALLOW_COMPANY !== COMPANY)
  fail(
    `COMPANY=${COMPANY} is not a synthetic perf company; set ALLOW_COMPANY=${COMPANY} to override`,
  );
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(BASE) && __ENV.ALLOW_REMOTE !== '1')
  fail(`BASE_URL ${BASE} is not local; set ALLOW_REMOTE=1 for a dedicated perf environment`);

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-arrival-rate',
      exec: 'browse',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 200,
      stages: [
        { target: BROWSE_RATE, duration: '2m' },
        { target: BROWSE_RATE, duration: DURATION },
        { target: 0, duration: '1m' },
      ],
    },
    post: {
      executor: 'ramping-arrival-rate',
      exec: 'post',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 200,
      stages: [
        { target: POST_RATE, duration: '2m' },
        { target: POST_RATE, duration: DURATION },
        { target: 0, duration: '1m' },
      ],
    },
  },
  // EXAMPLE starting targets (docs/performance-scalability-audit.md "Performance targets") -
  // to be replaced by SLAs agreed with the business.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:dashboard}': ['p(95)<1500'],
    'http_req_duration{name:gl}': ['p(95)<1000'],
    'http_req_duration{name:search}': ['p(95)<500'],
    'http_req_duration{name:post}': ['p(95)<1000'],
    journal_e2e: ['p(95)<2000'],
    dropped_iterations: ['count<10'],
  },
};

const journalE2e = new Trend('journal_e2e', true);
const journalsPosted = new Counter('journals_posted');

const JSON_HEADERS = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
let session = null; // per VU: { headers, accounts, heavy }

function login() {
  if (session) return session;
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({
      email: __ENV.EMAIL || 'admin@acme.local',
      password: __ENV.PASSWORD || 'P@ssw0rd123',
    }),
    { headers: JSON_HEADERS, tags: { name: 'login' } },
  );
  if (!check(res, { 'login 200': (r) => r.status === 200 })) fail(`login ${res.status}`);
  const companies = http
    .get(`${BASE}/companies`, { headers: JSON_HEADERS, tags: { name: 'companies' } })
    .json();
  const company = companies.find((c) => c.code === COMPANY);
  if (!company) fail(`company ${COMPANY} not visible to this user`);
  const headers = { ...JSON_HEADERS, 'x-company-id': company.id };
  const accounts = http
    .get(`${BASE}/accounts?postableOnly=true&search=Perf`, { headers, tags: { name: 'accounts' } })
    .json()
    .filter((a) => /^P[1-8]/.test(a.code));
  const heavy = accounts.find((a) => a.code === 'P1HEAVY');
  if (!heavy || accounts.length < 10) fail('PERF accounts missing - load perf-ledger.sql first');
  session = { headers, accounts: accounts.filter((a) => a.code !== 'P1HEAVY'), heavy };
  return session;
}

const monthStart = TODAY.slice(0, 8) + '01';
const lastMonthEnd = (() => {
  const d = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 1, 0));
  return d.toISOString().slice(0, 10);
})();

export function browse() {
  const s = login();
  group('dashboard', () => {
    // The six heaviest dashboard calls, as a browser batch (http.batch runs them in parallel).
    const reqs = [
      `/reports/balance-sheet?asOf=${TODAY}`,
      `/reports/balance-sheet?asOf=${lastMonthEnd}`,
      `/reports/income-statement/trend?to=${TODAY}&months=6`,
      `/reconciliations/summary?asOf=${TODAY}`,
      `/reports/ar-aging?asOf=${TODAY}`,
      `/reports/ap-aging?asOf=${TODAY}`,
    ].map((p) => ['GET', BASE + p, null, { headers: s.headers, tags: { name: 'dashboard' } }]);
    const res = http.batch(reqs);
    check(res, { 'dashboard all 200': (rs) => rs.every((r) => r.status === 200) });
  });
  group('search', () => {
    const r = http.get(
      `${BASE}/journal-entries?page=1&pageSize=25&search=PJ-0000${Math.floor(Math.random() * 9000) + 1000}`,
      {
        headers: s.headers,
        tags: { name: 'search' },
      },
    );
    check(r, { 'search 200': (x) => x.status === 200 });
  });
  group('general ledger', () => {
    const acct =
      Math.random() < 0.3 ? s.heavy : s.accounts[Math.floor(Math.random() * s.accounts.length)];
    const r = http.get(
      `${BASE}/general-ledger?accountId=${acct.id}&from=${TODAY.slice(0, 4)}-01-01&to=${TODAY}&page=1&pageSize=100`,
      { headers: s.headers, tags: { name: 'gl' } },
    );
    check(r, {
      'gl 200': (x) => x.status === 200,
      'gl has closing balance': (x) => x.json('closingBalance') !== undefined,
    });
  });
}

export function post() {
  const s = login();
  const key = `${RUN_ID}-${__VU}-${__ITER}`;
  const n = 2 + Math.floor(Math.random() * 5);
  const detail = Array.from(
    { length: n - 1 },
    () => (100 + Math.floor(Math.random() * 9900)) * 100,
  );
  const total = detail.reduce((a, b) => a + b, 0);
  const money = (c) => (c / 100).toFixed(2);
  const pick = () => s.accounts[Math.floor(Math.random() * s.accounts.length)].id;
  const body = {
    entryDate: TODAY,
    description: `k6 ${key}`,
    idempotencyKey: key,
    lines: [
      { accountId: s.heavy.id, debit: money(total), credit: '0' },
      ...detail.map((c) => ({ accountId: pick(), debit: '0', credit: money(c) })),
    ],
  };
  const t0 = Date.now();
  const step = (name, path, payload) =>
    http.post(`${BASE}${path}`, JSON.stringify(payload), {
      headers: { ...s.headers, 'idempotency-key': `${key}-${name}` },
      tags: { name },
    });
  const created = step('create', '/journal-entries', body);
  if (!check(created, { 'create 201': (r) => r.status === 201 })) return;
  const id = created.json('id');
  if (
    !check(step('submit', `/journal-entries/${id}/submit`, {}), {
      'submit ok': (r) => r.status < 300,
    })
  )
    return;
  if (
    !check(step('approve', `/journal-entries/${id}/approve`, {}), {
      'approve ok': (r) => r.status < 300,
    })
  )
    return;
  const posted = step('post', `/journal-entries/${id}/post`, {});
  if (
    !check(posted, {
      'post ok': (r) => r.status < 300,
      posted: (r) => r.json('status') === 'POSTED',
    })
  )
    return;
  journalE2e.add(Date.now() - t0);
  journalsPosted.add(1);
  // Retrieve the balance the posting moved (single-account read through the (company, account) path).
  const bal = http.get(
    `${BASE}/general-ledger?accountId=${s.heavy.id}&from=${monthStart}&to=${TODAY}&page=1&pageSize=1`,
    { headers: s.headers, tags: { name: 'balance' } },
  );
  check(bal, { 'balance 200': (r) => r.status === 200 });
}

export function handleSummary(data) {
  return {
    stdout: `\nrun ${RUN_ID}: journals posted = ${data.metrics.journals_posted?.values.count ?? 0}; now run perf-verify.sql with -v since=<run start>\n`,
    [`k6-summary-${RUN_ID}.json`]: JSON.stringify(data, null, 2),
  };
}
