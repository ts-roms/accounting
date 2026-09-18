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
