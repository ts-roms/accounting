# Lease integrity

`GET /leases/integrity?asOf` (`lease.view`), company-scoped, same shape as the
other integrity reports; also embedded in `GET /leases/dashboard`.

| Check                       | Severity | Assertion                                                                                                                                                                                                                         |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LEASE_LIABILITY_VS_LEDGER` | CRITICAL | The `LEASE_LIABILITY` credit balance at `asOf` equals the sum of the finance leases' liability changes (`lease_events`) dated on or before `asOf`.                                                                                |
| `ROU_ASSET_VS_LEDGER`       | CRITICAL | `RIGHT_OF_USE_ASSET` less `ROU_ACCUMULATED_DEPRECIATION` at `asOf` equals the sum of the right-of-use changes in `lease_events`.                                                                                                  |
| `LEASE_SCHEDULE_TOTALS`     | CRITICAL | Per active finance lease: the live schedule ends at zero, its depreciation sums to the ROU cost, and the register liability equals the first pending month's opening balance adjusted for instalments paid early or still unpaid. |
| `LEASE_RUNS_OVERDUE`        | WARNING  | No month of a finance lease that ended before the current month is still pending a run.                                                                                                                                           |
| `LEASE_PAYMENTS_OVERDUE`    | WARNING  | No unpaid instalment of an active lease is past its payment date.                                                                                                                                                                 |

The financial-close check `LEASE_RUNS_POSTED` is the period-scoped version of
`LEASE_RUNS_OVERDUE`.
