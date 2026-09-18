# Performance notes

How the platform is measured and the rules that keep read paths fast as the
ledger grows. Every report still derives from posted journal lines (see
`docs/accounting-engine.md`); nothing here introduces stored totals.

## Ledger read rules

- **Single-account balances go through `activity({ accountIds })`.** A control
  account, a bank GL account, a mapped account (`DEFERRED_REVENUE`,
  `EMPLOYEE_PAYABLE`, `RIGHT_OF_USE_ASSET`, ...) is read by filtering on
  `journal_lines(company_id, account_id)`, never by aggregating the whole
  company and picking one row out of the result. `GeneralLedgerService`
  repeats the company filter on the line side so the index applies.
- **Whole-ledger aggregates are for statements - and read the period-balance
  model.** Trial balance, income statement, balance sheet, cash flow and the
  report engine legitimately aggregate the whole window, but `activity()` and
  `activityByMonth()` serve every whole calendar month inside the window from
  `account_period_balances` (one row per account / month / journal type /
  dimension set) and touch `journal_lines` only for the days of a partial
  first or last month. See "Period-balance read model" below.
- **Trends are one read.** `GET /reports/income-statement/trend?to&months`
  buckets `activity()` by calendar month (`activityByMonth`) and returns
  section totals per month; the dashboard uses it for the chart and the
  month-to-date tiles instead of one full report per month.
- **Integrity checks stay bounded.** Every check is a single capped query
  (`LIMIT 20`). Checks that need the chart (dimension rules, branch
  restrictions) resolve the covered accounts first and let the database find
  offending lines; they never stream every posted line into Node. Foreign
  amounts are found through the partial index `journal_lines_foreign_idx`.
- **The dashboard reads the stored integrity run.** The health card shows the
  latest `integrity_runs` row (nightly job or "Run now" ->
  `POST /integrity/runs`) with its timestamp; `GET /integrity` remains the
  live audit for the integrity page. Running all 22 checks on every dashboard
  visit was the single largest share of database CPU under load.
- **Fan out independent reads inside a request.** The reconciliation summary
  evaluates its five areas and every bank account with `Promise.all`; under
  load each round trip also waits for a pool connection, so sequential
  `await`s multiply.
- **Cache authorization, not figures.** `AuthorizationCacheService` caches who
  may do what for a short TTL; ledger figures are never cached.

## Navigation (web)

"Navigation is slow" has two very different causes, so measure the right one.
`infrastructure/scripts/nav-measure.mjs <base>` (run from `apps/web`; the recipe is: click a real
sidebar link, then time from the click to the first DOM change inside
`<main>` and to the last one, with a MutationObserver installed by
`addInitScript`) against a **production build** (`next build` + `next start`)
and against `next dev`:

| Hop (click -> page content)  | Production, before | Production, after | Dev (Turbopack), before | Dev, after |
| ---------------------------- | ------------------ | ----------------- | ----------------------- | ---------- |
| Revisit (route already seen) | 40-120 ms          | 35-70 ms          | 0.7-3 s                 | 0.1-0.6 s  |
| First visit of a route       | 60-300 ms          | 30-270 ms         | 0.5-19 s                | 1.1-2.6 s  |

- **Production was never slow**: a hop is the API call plus 30-70 ms of
  rendering. What people feel in local development is Turbopack compiling each
  route on first visit (no prefetch in dev) and, before this change, a server
  round trip for the route shell on _every_ navigation.
- **Router cache** (`next.config.ts` `experimental.staleTimes: { dynamic: 300 }`):
  every screen is a client component that fetches its own data with React
  Query, so the server payload of a route is a static shell. Keeping visited
  routes in the client router cache makes revisits instant in both modes; data
  freshness is unaffected (React Query owns it).
- **Shared packages ship as ESM**: `types`, `validation`, `money` and
  `config` were CommonJS, which a bundler cannot tree-shake - every page that
  imported one schema carried the whole 460 kB validation bundle (the login
  page loaded 331 kB of JS). They now build twice (`dist` CommonJS for the
  API and Jest, `dist/esm` + `sideEffects: false` for Next through the
  `import` export condition; relative imports inside the packages carry
  `.js` extensions so Node can load the ESM build too). First-load JS: login
  331 -> 247 kB, heaviest routes 447 -> 363 kB; the biggest chunk fell from
  487 kB to 226 kB (the shell: cmdk / Radix, loaded once).
- **First load after sign-in** no longer fires company-scoped queries before
  the active company is chosen (`SessionProvider` keeps the shell skeleton
  until it is) - previously the first page of a fresh browser got 403s and
  refetched.

To feel the real thing locally, run the production build:
`pnpm --filter @accounting/web build && pnpm --filter @accounting/web start`
(the `.claude/launch.json` entries `api-verify` / `web-verify` do the same on
3011 / 3021).

## Period-balance read model

`account_period_balances` is the one derived table beside the ledger. It is
not an independent total - the "no independent totals" rule still holds - for
three reasons:

- **The database maintains it, not the application.** Triggers on
  `journal_lines` (insert / update / delete) and `journal_entries` (status
  entering or leaving `POSTED / LOCKED / REVERSED`) add or subtract each
  line's debit, credit and count in the same transaction as the ledger write
  (migration `0037_account_period_balances.sql`). No service writes it; a
  posting cannot succeed without the matching balance change.
- **It is proven, every run.** `PERIOD_BALANCES_VS_LEDGER` (CRITICAL) joins
  the stored rows to the same aggregation computed from the lines and reports
  every key whose debit, credit or line count differs - in the nightly
  integrity run, on the dashboard health card and in the e2e suite
  (`apps/api/test/period-balances.e2e-spec.ts`, which also checks
  `activity()` against the pure line scan `lineActivity()` under every
  statement filter).
- **It can always be thrown away.** `rebuild_account_period_balances(company)`
  (exposed as `POST /operations/period-balances/rebuild`, `operations.manage`,
  audited as `REBUILD`) recomputes a company from its lines. Use it after a
  repair that bypassed the triggers; nothing else ever needs it.

The key is (company, account, month, journal type, branch, department, cost
centre, project) with `UNIQUE NULLS NOT DISTINCT`, so every filter the
statements use (`branchId`, dimensions, `accountTypes` via the chart join,
`excludeJournalTypes`) applies to the model exactly as it applies to the
lines. A statement over N months therefore reads O(accounts x N x dimension
sets) rows instead of every posted line of the window.

## Measuring

Load a realistic volume into a throwaway database (the audit used 40,000
posted journals / 80,000 lines dated across nine months), run the production
API against it and time the endpoints:

```bash
docker exec -i accounting-postgres psql -U accounting -d accounting_ci < volume.sql
DATABASE_URL=postgres://accounting:accounting@127.0.0.1:5433/accounting_ci API_PORT=3013 node apps/api/dist/main.js
```

To see the SQL behind one endpoint, enable statement timing on that database
(`ALTER DATABASE accounting_ci SET log_min_duration_statement = 0`) and read
`docker logs accounting-postgres` while the request runs. Query plans:
`EXPLAIN (ANALYZE, BUFFERS)` on the logged statement.

## Load test

`infrastructure/scripts/load-test.mjs` replays the dashboard (16 calls, six at
a time like a browser) or a mixed navigation session with N closed-loop users
against a running API and prints throughput, page-load percentiles, per-endpoint
percentiles and the API's Postgres connection usage:

```bash
node infrastructure/scripts/load-test.mjs http://127.0.0.1:3001/api/v1 10 30 dashboard
node infrastructure/scripts/load-test.mjs http://127.0.0.1:3001/api/v1 10 30 mixed
```

Raise `AUTH_LOGIN_RATE_LIMIT` / `RATE_LIMIT_MAX` on the API under test.
`infrastructure/scripts/perf-volume.sql` loads the 40k-journal volume into a
throwaway database (it credits the AR / AP control accounts directly, so
reconciliations show variance afterwards).

### Findings (2026-09, 40k journals, 16-core workstation, Postgres in Docker)

| Dashboard users | Before: pages/s · p50 | After: pages/s · p50 |
| --------------- | --------------------- | -------------------- |
| 1               | 3.6 · 249 ms          | 4.5 · 177 ms         |
| 10              | 4.6 · 2.15 s          | 7.2 · 1.36 s         |
| 20              | 3.7 · 5.2 s           | 6.6 · 3.0 s          |

- The limit is **Postgres CPU**, not the API process or the pool: at ten users
  Postgres ran at 600-1000 % of a core while the Node process used ~20 % of
  one, and a pool of 20 or 40 gave the same throughput as the default 10 (the
  default stays). Every whole-ledger aggregate on the page (two balance sheets,
  the trend, the aging reports, the integrity audit) competes for the same
  cores; requests that need only a few milliseconds queue behind them.
- A pool of 40 also ran Postgres out of dynamic shared memory (Docker's 64 MB
  `/dev/shm`) and returned 500s - hence `shm_size: 256m` in the compose file.
- Reads that issue many small statements (the reconciliation summary: 60) are
  latency-bound alone and pool-bound under load; they were serialised per area
  and per bank account.

Scaling beyond this meant fewer whole-ledger aggregates per page: the
period-balance read model above (a deliberate design decision, not a tuning
change - the ledger stays the only source of truth because the database keeps
the model in step and the integrity check proves it).

## Audit baseline (2026-09, 40k journals, production build)

| Endpoint                              | Before      | After       |
| ------------------------------------- | ----------- | ----------- |
| `GET /controls/dashboard`             | 766 ms      | 227 ms      |
| `GET /integrity`                      | 642 ms      | 152 ms      |
| `GET /reconciliations/summary`        | 407 ms      | 177 ms      |
| `GET /treasury/dashboard`             | 259 ms      | 102 ms      |
| `GET /treasury/forecast`              | 225 ms      | 74 ms       |
| `GET /leases/dashboard`               | 125 ms      | 23 ms       |
| `GET /revenue/integrity`              | 115 ms      | 23 ms       |
| Dashboard page (API calls / last end) | 21 / 1.06 s | 16 / 0.60 s |

Statements (`/reports/*`) were 35-60 ms before and after: they are the
whole-ledger reads the rules above allow. The remaining floor of the
integrity report is the balanced-journal check (one aggregate over every
posted entry, ~140 ms at 40k journals).

### Period-balance read model (2026-09, 40k journals, production build)

Best of three interleaved rounds against the same database, main build on one
port and this branch on another (the workstation was noisy, so single runs
varied by 50 %; interleaving and taking the best keeps the comparison honest):

| Endpoint                                     | Lines only | Read model |
| -------------------------------------------- | ---------- | ---------- |
| `GET /reports/trial-balance` (Jan-Sep)       | 53 ms      | 10 ms      |
| `GET /reports/balance-sheet`                 | 47 ms      | 8 ms       |
| `GET /reports/cash-flow` (Jan-Sep)           | 44 ms      | 7 ms       |
| `GET /reports/income-statement` (Jan-Sep)    | 40 ms      | 8 ms       |
| `GET /reports/income-statement` (one month)  | 23 ms      | 7 ms       |
| `GET /reports/income-statement/trend` (6 mo) | 70 ms      | 28 ms      |
| `GET /reconciliations/summary`               | 58 ms      | 34 ms      |
| `GET /treasury/dashboard`                    | 112 ms     | 69 ms      |
| `GET /integrity` (now 23 checks)             | 200 ms     | 191 ms     |

Whole-window statements no longer scale with the number of posted lines: a
year of history is ~12 rows per account per dimension set. Endpoints that
never aggregate the ledger (lists, agings, single-account reads) are unchanged
within noise. The integrity report gained `PERIOD_BALANCES_VS_LEDGER` (one
full-ledger aggregate) and still came out level because every other ledger
read inside it got cheaper. The ten-user dashboard load test was inconclusive
on the day (4.1-8.3 pages/s for both builds across rounds); its page is now
dominated by the reconciliation summary and the AR / AP agings, which read
subledgers, not the ledger.
