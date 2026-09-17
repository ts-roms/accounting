# Revenue recognition integrity

`GET /revenue/integrity?asOf` (`revenue.view`), company-scoped, same shape
as the other integrity reports.

| Check                        | Severity | Assertion                                                                                                                                   |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFERRED_REVENUE_VS_LEDGER` | CRITICAL | The `DEFERRED_REVENUE` credit balance at `asOf` equals the schedule rollforward closing balance (invoices posted, runs dated, voids dated). |
| `SCHEDULE_TOTALS`            | CRITICAL | Each schedule's non-cancelled lines sum to its total and its recognized amount equals its `RECOGNIZED` lines.                               |
| `RECOGNIZED_WITHOUT_JOURNAL` | CRITICAL | Every `RECOGNIZED` line points at a `POSTED` run with a journal.                                                                            |
| `OVERDUE_RECOGNITION`        | WARNING  | No due line (completed milestones included) is older than `asOf` minus `revenue_settings.overdueGraceDays` without a run.                   |

The web surfaces the report on the Deferred Revenue page next to the
rollforward, whose "ledger difference" is the same assertion for the
selected window.
