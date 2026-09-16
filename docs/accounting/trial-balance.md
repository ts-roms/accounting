# Trial balance

`GET /api/v1/reports/trial-balance?from=&to=&branchId=&departmentId=&costCenterId=&projectId=&includeZero=`
(`reports.view`). Source: `ReportingService.trialBalance`.

For every postable account:

| Column                           | Derivation                                           |
| -------------------------------- | ---------------------------------------------------- |
| `openingDebit` / `openingCredit` | net of all posted lines before `from`, split by sign |
| `periodDebit` / `periodCredit`   | sums within `[from, to]`                             |
| `closingDebit` / `closingCredit` | opening net + period debit - period credit, split    |

Totals are returned for every column and `balanced` is `true` only when
`periodDebit = periodCredit` **and** `closingDebit = closingCredit`. The same
assertion runs in the integrity checker (`STATEMENTS_BALANCE`) and in the e2e
suites.

Filters: company (header), branch, fiscal year / period (choose the dates),
date range and dimensions. Zero-activity accounts are hidden unless
`includeZero=true`.

The page (`/accounting/trial-balance`) links every account to its ledger for
the same window.
