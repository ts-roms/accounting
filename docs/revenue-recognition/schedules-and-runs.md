# Revenue schedules, runs and reports

## Lifecycle

```
invoice line { revenuePolicyId?, serviceStartDate?, serviceEndDate?, milestones? }
POST /invoices, PATCH /invoices/:id          validates the window / milestones (REVENUE_SCHEDULE_INVALID)
POST /invoices/:id/post                       Dr AR / Cr DEFERRED_REVENUE (deferred lines) -> revenue_schedules + lines
POST /revenue/schedules/:id/lines/:lineId/complete { completedOn?, note? }   revenue.manage   milestone becomes due
GET  /revenue/runs/preview?periodEnd          what a run would recognize
POST /revenue/runs { periodEnd, description?, scheduleIds? }   revenue.recognize   one ADJUSTING journal, RRN number
POST /revenue/runs/:id/reverse { reason }     revenue.recognize   latest run first; lines back to PENDING
POST /invoices/:id/void                       refused with REVENUE_RECOGNIZED while any line is recognized
```

## Worked example (the seed, ACME)

| Invoice                                     | Policy        | Schedule                                                                                |
| ------------------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| INV 2026-06-01, 120,000 annual support plan | `RATABLE-SVC` | 12 lines, 2026-06-01 to 2027-05-31 by day: June 9,863.0137, July 10,191.7809, ...       |
| INV 2026-07-15, 90,000 ERP rollout          | `MILESTONE`   | Kick-off 30% (done 07-15), Configuration accepted 40% (done 08-20), Go-live 30% (10-15) |

Runs `RRN-2026-000001..3` on June 30 / July 31 / August 31 recognized
9,863.0137 / 37,191.7809 / 46,191.7809; the deferred balance on
2026-08-31 is 116,753.4245 in both the schedules and account `2190`.

## Reports (`revenue.view`)

- `GET /revenue/reports/rollforward?from&to` - opening + billed (invoices
  posted in the window) - recognized (runs whose period end falls in the
  window) - voided = closing, per method and in total, with the ledger's
  `DEFERRED_REVENUE` credit balance at `to` and the difference (always
  0 when the books are consistent).
- `GET /revenue/reports/waterfall?from&months` - pending lines by the month
  they fall due (overdue lines land in the first bucket, undated milestones
  under `unscheduled`, later lines under `beyond`), overall and per
  customer.
- `GET /revenue/reports/backlog?asOf` - contracted-but-unearned by
  customer: deferred, due within 30 days, overdue (due but not yet run),
  unscheduled.
- `GET /revenue/integrity?asOf` - see `integrity.md`.

## Financial close

The close checklist gains the automatic task `REVENUE_RECOGNITION`
("Deferred revenue recognized"): it passes when no pending schedule line
dated on or before the period end (milestones: completed ones) is waiting
for a run. `accounting_policies.closeRequireRevenueRecognition` (default
true) decides whether a failure blocks the close.

## Scheduler

`revenue-recognition` (queue `accounting-schedules`, same cron as the
accounting schedules) calls `RevenueRunsService.recognizeAllCompanies`: for
every active company with `revenue_settings.autoRecognize`, one run up to
today limited to policies with `autoRecognize`. `POST /revenue/recognize-now?asOf`
triggers it on demand (`revenue.recognize`). Runs lock the lines they
recognize, so reruns never double-post.
