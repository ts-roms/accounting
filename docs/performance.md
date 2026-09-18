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
- **Whole-ledger aggregates are for statements.** Trial balance, income
  statement, balance sheet, cash flow and the report engine legitimately read
  every posted line of the window (one `GROUP BY account_id` per window).
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

Scaling beyond this means either more database cores or fewer whole-ledger
aggregates per page (for example a period-balance read model - a deliberate
design decision, not a tuning change, because the ledger must stay the only
source of truth).

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
