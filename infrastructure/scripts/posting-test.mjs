// Posting throughput + concurrency correctness against a running API (throwaway perf database
// loaded with perf-ledger.sql - the journals use its PERF accounts, never control accounts).
// Every scenario ends by running perf-verify.sql for the rows this run wrote: a fast run that
// fails the gate is a FAILED run (exit code 1).
//
//   node infrastructure/scripts/posting-test.mjs <base> <scenario> [writers] [seconds]
//
//   throughput  N writers loop create -> submit -> approve -> post (4 calls, like the UI)
//   duplicates  for R in 2,10,100: the same post / create / reverse request R times at once
//               (with and without a shared Idempotency-Key) - must be one financial posting
//   mixed       writers + reversers + trial-balance readers at the same time
//
// Env: PERF_DB (psql URL for perf-verify, default postgres://accounting:accounting@127.0.0.1:5433/perf10m),
//      COMPANY (company code, default ACME), EMAIL / PASSWORD (default the seeded admin).
// Raise RATE_LIMIT_MAX / AUTH_LOGIN_RATE_LIMIT on the API under test.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const base = process.argv[2] ?? 'http://127.0.0.1:3013/api/v1';
const SCENARIO = process.argv[3] ?? 'throughput';
const WRITERS = Number(process.argv[4] ?? 4);
const SECONDS = Number(process.argv[5] ?? 30);
const PERF_DB = process.env.PERF_DB ?? 'postgres://accounting:accounting@127.0.0.1:5433/perf10m';
const COMPANY = process.env.COMPANY ?? 'ACME';
const ENTRY_DATE = process.env.ENTRY_DATE ?? '2026-09-15';
const H = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
const startedAt = new Date(Date.now() - 1000).toISOString();

const psql = (sql) => execFileSync('psql', [PERF_DB, '-Atc', sql]).toString().trim();

async function session() {
  const login = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      email: process.env.EMAIL ?? 'admin@acme.local',
      password: process.env.PASSWORD ?? 'P@ssw0rd123',
    }),
  });
  if (login.status !== 200) throw new Error('login ' + login.status + ' ' + (await login.text()));
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const companies = await fetch(base + '/companies', { headers: { ...H, cookie } }).then((r) =>
    r.json(),
  );
  const company = companies.find((c) => c.code === COMPANY);
  if (!company) throw new Error('company ' + COMPANY + ' not visible');
  return { ...H, cookie, 'x-company-id': company.id, companyId: company.id };
}

// PERF accounts of the company (perf-ledger.sql): P1HEAVY first, then the rest.
function perfAccounts(companyId) {
  const rows = psql(
    `select id from accounts where company_id = '${companyId}' and code ~ '^P[1-8]' and not is_header order by code = 'P1HEAVY' desc, code`,
  ).split('\n');
  if (rows.length < 10) throw new Error('no PERF accounts - load perf-ledger.sql first');
  return rows;
}

const stats = new Map(); // step -> { ms: [], errors: Map<code, n> }
function record(step, ms, status, code) {
  const s = stats.get(step) ?? { ms: [], errors: new Map() };
  s.ms.push(ms);
  if (status >= 400 || status === 0) {
    const k = `${status} ${code ?? ''}`.trim();
    s.errors.set(k, (s.errors.get(k) ?? 0) + 1);
  }
  stats.set(step, s);
}

async function call(h, step, method, path, body, extra = {}) {
  const t = performance.now();
  try {
    const { companyId: _c, ...headers } = h;
    const r = await fetch(base + path, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    record(step, performance.now() - t, r.status, json?.code ?? json?.error?.code);
    return { status: r.status, json, replayed: r.headers.get('idempotent-replayed') === 'true' };
  } catch (e) {
    record(step, performance.now() - t, 0, e.code ?? e.message);
    return { status: 0, json: null };
  }
}

function journalBody(accounts, heavy) {
  const n = 2 + Math.floor(Math.random() * 5);
  const detail = Array.from(
    { length: n - 1 },
    () => (100 + Math.floor(Math.random() * 9900)) * 100,
  ); // cents
  const total = detail.reduce((a, b) => a + b, 0);
  const pick = () => accounts[1 + Math.floor(Math.random() * (accounts.length - 1))];
  const money = (cents) => (cents / 100).toFixed(2);
  return {
    entryDate: ENTRY_DATE,
    description: 'posting-test ' + randomUUID().slice(0, 8),
    lines: [
      { accountId: heavy ? accounts[0] : pick(), debit: money(total), credit: '0' },
      ...detail.map((c) => ({ accountId: pick(), debit: '0', credit: money(c) })),
    ],
  };
}

const posted = [];
let lines = 0;

async function createApproved(h, accounts, heavy) {
  const body = journalBody(accounts, heavy);
  const c = await call(h, 'create', 'POST', '/journal-entries', body);
  if (c.status >= 300) return null;
  const id = c.json.id;
  if ((await call(h, 'submit', 'POST', `/journal-entries/${id}/submit`, {})).status >= 300)
    return null;
  if ((await call(h, 'approve', 'POST', `/journal-entries/${id}/approve`, {})).status >= 300)
    return null;
  return { id, lines: body.lines.length };
}

async function writer(h, accounts, deadline, heavyShare) {
  while (Date.now() < deadline) {
    const t = performance.now();
    const j = await createApproved(h, accounts, Math.random() < heavyShare);
    if (!j) continue;
    const p = await call(h, 'post', 'POST', `/journal-entries/${j.id}/post`, {});
    if (p.status < 300) {
      posted.push(j.id);
      lines += j.lines;
      record('journal (4 calls)', performance.now() - t, 200);
    }
  }
}

async function reverser(h, deadline) {
  while (Date.now() < deadline) {
    const id = posted.splice(Math.floor(Math.random() * posted.length), 1)[0];
    if (!id) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    await call(h, 'reverse', 'POST', `/journal-entries/${id}/reverse`, {
      reversalDate: ENTRY_DATE,
    });
  }
}

async function reader(h, deadline) {
  while (Date.now() < deadline) {
    await call(
      h,
      'trial-balance',
      'GET',
      `/reports/trial-balance?from=2026-01-01&to=${ENTRY_DATE}`,
    );
  }
}

async function duplicates(h, accounts) {
  const out = [];
  for (const R of [2, 10, 100]) {
    // (a) the same post request R times, no Idempotency-Key: postEntry's row lock + status check.
    const a = await createApproved(h, accounts, true);
    const ra = await Promise.all(
      Array.from({ length: R }, () =>
        call(h, `dup-post x${R}`, 'POST', `/journal-entries/${a.id}/post`, {}),
      ),
    );
    // (b) the same post R times with one Idempotency-Key: the interceptor replays / 409s.
    const b = await createApproved(h, accounts, true);
    const key = 'perf-' + randomUUID();
    const rb = await Promise.all(
      Array.from({ length: R }, () =>
        call(
          h,
          `dup-post-key x${R}`,
          'POST',
          `/journal-entries/${b.id}/post`,
          {},
          { 'idempotency-key': key },
        ),
      ),
    );
    // (c) the same create R times with one body idempotencyKey: must be one journal.
    const body = { ...journalBody(accounts, true), idempotencyKey: 'perf-' + randomUUID() };
    const rc = await Promise.all(
      Array.from({ length: R }, () =>
        call(h, `dup-create x${R}`, 'POST', '/journal-entries', body),
      ),
    );
    // (d) the same reverse R times: one REVERSAL journal.
    const d = await createApproved(h, accounts, true);
    await call(h, 'post', 'POST', `/journal-entries/${d.id}/post`, {});
    const rd = await Promise.all(
      Array.from({ length: R }, () =>
        call(h, `dup-reverse x${R}`, 'POST', `/journal-entries/${d.id}/reverse`, {
          reversalDate: ENTRY_DATE,
        }),
      ),
    );
    const n = (sql) => Number(psql(sql));
    const summary = (rs) => {
      const m = {};
      for (const r of rs) {
        const k = r.replayed
          ? `${r.status} replay`
          : `${r.status}${r.json?.code ? ' ' + r.json.code : ''}`;
        m[k] = (m[k] ?? 0) + 1;
      }
      return JSON.stringify(m);
    };
    out.push({
      R,
      post: `${summary(ra)} posted-audits=${n(`select count(*) from audit_logs where entity_id='${a.id}' and action='POST' and metadata ? 'lines'`)}`,
      postWithKey: `${summary(rb)} posted-audits=${n(`select count(*) from audit_logs where entity_id='${b.id}' and action='POST' and metadata ? 'lines'`)}`,
      create: `${summary(rc)} journals=${n(`select count(*) from journal_entries where idempotency_key='${body.idempotencyKey}'`)}`,
      reverse: `${summary(rd)} reversals=${n(`select count(*) from journal_entries where reversal_of_id='${d.id}'`)}`,
    });
  }
  return out;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const h = await session();
const accounts = perfAccounts(h.companyId);
const deadlocks0 = Number(
  psql(`select deadlocks from pg_stat_database where datname = current_database()`),
);
const t0 = performance.now();
if (SCENARIO === 'throughput') {
  const deadline = Date.now() + SECONDS * 1000;
  await Promise.all(
    Array.from({ length: WRITERS }, () =>
      writer(h, accounts, deadline, Number(process.env.HEAVY_SHARE ?? 0.3)),
    ),
  );
} else if (SCENARIO === 'mixed') {
  const deadline = Date.now() + SECONDS * 1000;
  await Promise.all([
    ...Array.from({ length: WRITERS }, () => writer(h, accounts, deadline, 0.3)),
    ...Array.from({ length: Math.max(1, Math.floor(WRITERS / 4)) }, () => reverser(h, deadline)),
    ...Array.from({ length: Math.max(1, Math.floor(WRITERS / 4)) }, () => reader(h, deadline)),
  ]);
} else if (SCENARIO === 'duplicates') {
  for (const row of await duplicates(h, accounts)) console.log(JSON.stringify(row));
} else throw new Error('unknown scenario ' + SCENARIO);
const elapsed = (performance.now() - t0) / 1000;
const deadlocks =
  Number(psql(`select deadlocks from pg_stat_database where datname = current_database()`)) -
  deadlocks0;

const journals = stats.get('journal (4 calls)')?.ms.length ?? 0;
console.log(
  `scenario=${SCENARIO} writers=${WRITERS} ${elapsed.toFixed(0)}s journals=${journals} (${(journals / elapsed).toFixed(1)}/s) lines=${lines} (${(lines / elapsed).toFixed(1)}/s) deadlocks=${deadlocks}`,
);
for (const [step, s] of [...stats.entries()].sort()) {
  const errs = [...s.errors.entries()].map(([k, v]) => `${k} x${v}`).join(', ');
  console.log(
    step.padEnd(20),
    `n=${String(s.ms.length).padStart(6)} p50=${pct(s.ms, 50).toFixed(0).padStart(5)} p95=${pct(s.ms, 95).toFixed(0).padStart(5)} p99=${pct(s.ms, 99).toFixed(0).padStart(5)} ms`,
    errs ? ` errors: ${errs}` : '',
  );
}

// Correctness gate for everything this run wrote.
try {
  const out = execFileSync(
    'psql',
    [
      PERF_DB,
      '-q',
      '-v',
      `since=${startedAt}`,
      '-f',
      new URL('./perf-verify.sql', import.meta.url).pathname,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).toString();
  console.log(
    out
      .split('\n')
      .filter((l) => / FAIL | WARN |perf-verify/.test(l))
      .join('\n'),
  );
} catch (e) {
  console.log(
    String(e.stdout ?? '')
      .split('\n')
      .filter((l) => / FAIL | WARN |perf-verify/.test(l))
      .join('\n'),
  );
  console.log(
    String(e.stderr ?? '')
      .split('\n')
      .filter((l) => /ERROR|FAIL/.test(l))
      .join('\n'),
  );
  process.exitCode = 1;
}
