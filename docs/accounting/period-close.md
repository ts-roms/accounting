# Fiscal calendar and period close

Sources: `modules/accounting/fiscal/`, `modules/financial-close/`,
`modules/reconciliation/`. See also [../financial-close.md](../financial-close.md)
and [../reconciliation.md](../reconciliation.md).

## Fiscal calendar

`fiscal_years` -> 12 (or 13) `fiscal_periods` per company, created from a start
date (`POST /api/v1/fiscal-years`); overlaps are rejected. Period numbers 1-13
allow an adjustment period.

| Status        | Posting                                                            | Transition                                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `OPEN`        | anyone with posting authority                                      | -> SOFT_CLOSED / CLOSED                     |
| `SOFT_CLOSED` | only `period.post-soft-closed` (late adjustments) or the scheduler | -> OPEN / CLOSED                            |
| `CLOSED`      | nobody except the year-end routine                                 | -> OPEN (`period.reopen`, reason mandatory) |
| `LOCKED`      | nobody, ever                                                       | final                                       |

Periods close in sequence; closing requires no DRAFT / SUBMITTED / APPROVED
entries in the period and locks the posted ones (`LOCKED`). Reopening is
allowed only for the latest closed period of an open year and is never silent
(`PERIOD_REOPEN` audit with the reason). Every change is audited
(`PERIOD_CLOSE`, `PERIOD_SOFT_CLOSE`, `PERIOD_LOCK`, `PERIOD_REOPEN`,
`YEAR_CLOSE`).

## Month-end close

`modules/financial-close` is the only UI path that closes a period. A close
run builds a checklist whose automatic tasks are evaluated from ledger data
(never ticked by hand) and whose manual tasks need a sign-off:

```
Bank reconciliation        <- reconciliation records (banking)
AR reconciliation          <- SubledgerBalancesService (AR control vs open documents)
AP reconciliation          <- SubledgerBalancesService
Inventory reconciliation   <- inventory balances vs inventory accounts
Tax reconciliation         <- tax transactions vs tax accounts
Suspense review            <- manual (see /accounting/suspense)
Adjustments                <- no unposted journals in the period
Financial review           <- integrity report status
Approval                   <- four-eyes
Period close               <- FiscalPeriodsService.closePeriod in the same transaction
```

Policy flags in `accounting_policies` decide which failures block. Future
modules contribute checks by adding a task kind and its evaluator.

## Year-end close

`POST /api/v1/fiscal-years/:id/close` (`period.close`): every period must be
closed; a `CLOSING` journal dated on the last day transfers the net balance of
every income-statement account (revenue, cost of sales, expenses, other income,
other expenses) to the `RETAINED_EARNINGS` mapping; the year becomes `CLOSED`
and its periods can no longer be reopened.

## Schedules around the close

The nightly job (`ACCOUNTING_SCHEDULES_CRON`) generates due recurring
occurrences and prepayment recognitions; both can also be run on demand from
the UI before closing a period so accruals and recognitions are in.
