// Sequential (one request at a time) latency + payload benchmark of the ledger / report reads
// over a window matrix, against a running API. Complements load-test.mjs (concurrency): this one
// answers "how long does ONE report take at this data volume", with no queueing in the numbers.
//
//   node infrastructure/scripts/report-bench.mjs <base> [rounds] [filter]
//
// Env: COMPANY (default ACME), TODAY (default 2026-09-18, the pinned business date the perf data
// ends on), HEAVY_ACCOUNT / COLD_ACCOUNT codes for the general-ledger rows (default P1HEAVY and the
// least-used PERF account). Prints p50 / p95 / max ms, response bytes and gzip bytes per case.
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const base = process.argv[2] ?? 'http://127.0.0.1:3013/api/v1';
const ROUNDS = Number(process.argv[3] ?? 5);
const FILTER = process.argv[4] ? new RegExp(process.argv[4]) : null;
const TODAY = process.env.TODAY ?? '2026-09-18';
const PERF_DB = process.env.PERF_DB ?? 'postgres://accounting:accounting@127.0.0.1:5433/perf10m';
const H = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };

const login = await fetch(base + '/auth/login', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ email: 'admin@acme.local', password: 'P@ssw0rd123' }),
});
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const companies = await fetch(base + '/companies', { headers: { ...H, cookie } }).then((r) =>
  r.json(),
);
const company = companies.find((c) => c.code === (process.env.COMPANY ?? 'ACME'));
const headers = { ...H, cookie, 'x-company-id': company.id };
const q = (sql) => execFileSync('psql', [PERF_DB, '-Atc', sql]).toString().trim();
const heavy = q(
  `select id from accounts where company_id='${company.id}' and code='${process.env.HEAVY_ACCOUNT ?? 'P1HEAVY'}'`,
);
const cold = process.env.COLD_ACCOUNT
  ? q(
      `select id from accounts where company_id='${company.id}' and code='${process.env.COLD_ACCOUNT}'`,
    )
  : q(
      `select a.id from accounts a join account_period_balances b on b.account_id=a.id where a.company_id='${company.id}' and a.code like 'P6%' group by a.id order by sum(b.line_count) limit 1`,
    );

const y = Number(TODAY.slice(0, 4));
const monthStart = TODAY.slice(0, 8) + '01';
const lastMonthEnd = new Date(Date.UTC(y, Number(TODAY.slice(5, 7)) - 1, 0))
  .toISOString()
  .slice(0, 10);
const minus = (months) => {
  const d = new Date(Date.UTC(y, Number(TODAY.slice(5, 7)) - 1 - months, 1));
  return d.toISOString().slice(0, 10);
};
const cases = [
  // Trial balance windows: whole months come from the read model, partial edges from the lines.
  ['TB one day', `/reports/trial-balance?from=${TODAY}&to=${TODAY}`],
  ['TB one week', `/reports/trial-balance?from=2026-09-12&to=${TODAY}`],
  ['TB month-to-date', `/reports/trial-balance?from=${monthStart}&to=${TODAY}`],
  ['TB full month', `/reports/trial-balance?from=${minus(1)}&to=${lastMonthEnd}`],
  ['TB 3 months (whole)', `/reports/trial-balance?from=${minus(3)}&to=${lastMonthEnd}`],
  ['TB 6 months (whole)', `/reports/trial-balance?from=${minus(6)}&to=${lastMonthEnd}`],
  ['TB 12 months (whole)', `/reports/trial-balance?from=${minus(12)}&to=${lastMonthEnd}`],
  ['TB 24 months (whole)', `/reports/trial-balance?from=${minus(24)}&to=${lastMonthEnd}`],
  ['TB year-to-date', `/reports/trial-balance?from=${y}-01-01&to=${TODAY}`],
  ['TB mid-month edges', `/reports/trial-balance?from=${minus(6).slice(0, 8)}15&to=${TODAY}`],
  ['IS month-to-date', `/reports/income-statement?from=${monthStart}&to=${TODAY}`],
  ['IS year-to-date', `/reports/income-statement?from=${y}-01-01&to=${TODAY}`],
  ['IS trend 6 months', `/reports/income-statement/trend?to=${TODAY}&months=6`],
  ['IS trend 12 months', `/reports/income-statement/trend?to=${TODAY}&months=12`],
  ['BS as of today', `/reports/balance-sheet?asOf=${TODAY}`],
  ['BS month end', `/reports/balance-sheet?asOf=${lastMonthEnd}`],
  ['CF year-to-date', `/reports/cash-flow?from=${y}-01-01&to=${TODAY}`],
  [
    'GL heavy MTD p1',
    `/general-ledger?accountId=${heavy}&from=${monthStart}&to=${TODAY}&page=1&pageSize=100`,
  ],
  [
    'GL heavy YTD p1',
    `/general-ledger?accountId=${heavy}&from=${y}-01-01&to=${TODAY}&page=1&pageSize=100`,
  ],
  [
    'GL heavy YTD p500',
    `/general-ledger?accountId=${heavy}&from=${y}-01-01&to=${TODAY}&page=500&pageSize=100`,
  ],
  [
    'GL heavy YTD 500/pg',
    `/general-ledger?accountId=${heavy}&from=${y}-01-01&to=${TODAY}&page=1&pageSize=500`,
  ],
  [
    'GL cold YTD p1',
    `/general-ledger?accountId=${cold}&from=${y}-01-01&to=${TODAY}&page=1&pageSize=100`,
  ],
  ['Journals list p1', '/journal-entries?page=1&pageSize=25'],
  ['Journals list p2000', '/journal-entries?page=2000&pageSize=25'],
  ['Reconciliation summary', `/reconciliations/summary?asOf=${TODAY}`],
  ['Treasury dashboard', `/treasury/dashboard?asOf=${TODAY}`],
  ['Controls dashboard', `/controls/dashboard?asOf=${TODAY}`],
  ['Integrity (live, 23 checks)', `/integrity?asOf=${TODAY}`],
  ['Integrity latest run', '/integrity/runs/latest'],
].filter(([name]) => !FILTER || FILTER.test(name));

const pct = (a, p) =>
  [...a].sort((x, z) => x - z)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
console.log('case'.padEnd(28), '  p50    p95    max  status    bytes  gzipped');
for (const [name, path] of cases) {
  const ms = [];
  let bytes = 0;
  let gz = 0;
  let status = 0;
  for (let i = 0; i < ROUNDS; i += 1) {
    const t = performance.now();
    const r = await fetch(base + path, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    ms.push(performance.now() - t);
    status = r.status;
    bytes = buf.length;
    gz = gzipSync(buf).length;
  }
  console.log(
    name.padEnd(28),
    pct(ms, 50).toFixed(0).padStart(5),
    pct(ms, 95).toFixed(0).padStart(6),
    Math.max(...ms)
      .toFixed(0)
      .padStart(6),
    String(status).padStart(6),
    String(bytes).padStart(9),
    String(gz).padStart(8),
  );
}
