# Revenue recognition & deferred revenue - architecture

Prompt #10 adds revenue recognition to the order-to-cash platform: policies
that say _when_ an invoice line's revenue is earned, deferred revenue
schedules created by invoice posting, month-end recognition runs that move
deferred revenue to revenue, milestone completion, the rollforward /
waterfall / backlog reports, a financial-close check, a scheduled job and
integrity checks. Everything is company-scoped and every figure derives from
the schedule lines, which are proven against the `DEFERRED_REVENUE` account.

## Module layout (`apps/api/src/modules/revenue`)

| File                           | Responsibility                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revenue.logic.ts`             | Pure arithmetic: service window resolution, day-prorated ratable schedules, percentage milestone schedules, waterfall bucketing, deferred balance.         |
| `revenue-config.service.ts`    | Policies (`revenue_policies`), settings (`revenue_settings`) and the line -> product -> company-default policy resolution.                                 |
| `revenue-schedules.service.ts` | Draft-time validation of lines, the posting hook that builds schedules and swaps the credit account, the void guard, schedule views, milestone completion. |
| `revenue-runs.service.ts`      | Recognition runs: preview, post (one adjusting journal), reverse (latest first), the scheduler entry point.                                                |
| `revenue-reports.service.ts`   | Rollforward (proven against the ledger), waterfall, backlog, integrity checks.                                                                             |
| `revenue.job.ts`               | `revenue-recognition` job on the accounting-schedules queue (H8 registry).                                                                                 |
| `revenue.controller.ts`        | `/revenue/*` (see `docs/api.md`).                                                                                                                          |

`RevenueModule` is imported by `ReceivablesModule` (invoice posting calls
into it) and therefore never imports receivables itself.

## Data

- `revenue_policies` - code, name, `method` (`POINT_IN_TIME`, `RATABLE`,
  `MILESTONE`), `defaultTermMonths` (ratable only), `autoRecognize`, status.
- `revenue_settings` - one row per company: `autoRecognize` (the job posts
  by itself), `overdueGraceDays`, `defaultPolicyId`.
- `invoice_lines.revenue_policy_id / service_start_date / service_end_date /
milestones` and `products.revenue_policy_id` - what the line carries.
- `revenue_schedules` - one per deferred invoice line: policy, method,
  total / recognized (base currency), deferred and revenue accounts, the
  service window, the line's branch and dimensions, status
  `ACTIVE / COMPLETED / CANCELLED`.
- `revenue_schedule_lines` - sequence, recognition date, amount, status
  `PENDING / RECOGNIZED / CANCELLED`, milestone name / percent / completion,
  the run and journal that recognized it.
- `revenue_recognition_runs` - `RRN` numbered, period end, totals, journal,
  reversal journal and reason, `POSTED / REVERSED`.
- `accounting_policies.close_require_revenue_recognition` - whether the
  `REVENUE_RECOGNITION` close check blocks.

## Accounting decisions

- **Policy resolution is line -> product -> company default.** No policy,
  an inactive default, or `POINT_IN_TIME` means the line earns its revenue
  when the invoice posts, exactly as before Prompt #10. An explicitly chosen
  inactive policy is refused.
- **Invoices only.** Credit and debit notes always hit revenue directly; a
  note that references a policy or milestones is refused at draft time.
- **Draft-time validation.** `InvoicesService.create/update` call
  `RevenueSchedulesService.validateDraftLines`, so a service window that
  runs backwards, a ratable line with no end and no policy term, or
  milestones that do not sum to 100% fail when the line is entered
  (`REVENUE_SCHEDULE_INVALID`), not at posting.
- **Posting swaps the credit, nothing else.** Inside the invoice posting
  transaction `deferInvoiceLines` creates the schedules and returns the
  `DEFERRED_REVENUE` account for each deferred line; the AR control, tax,
  stock and dimension handling are untouched. Schedule amounts are the
  line's base-currency net amount, so the schedule always mirrors the
  journal.
- **Ratable = by day, per calendar month.** `Money.allocate` over the days
  each month covers (remainder minor units on the earliest lines), so the
  lines sum to the amount exactly; each line is dated on its month end, the
  last on the service end date.
- **Milestones fall due only when completed.** The expected date drives the
  waterfall / backlog; `completeMilestone` sets the recognition date to the
  completion date, and only then does a run pick the line up.
- **A run is one journal.** Every due line (dated on or before the period
  end) posts Dr deferred / Cr the line's revenue account with the invoice
  line's branch and dimensions in one `ADJUSTING` entry dated on the period
  end, source `REVENUE_RECOGNITION_RUN` (registered in `SOURCE_TABLES`),
  permission `revenue.recognize`. Nothing due = no run. Schedule totals are
  recomputed from the lines after every run and reversal (the lines are the
  truth).
- **Reversal is latest first.** `reverseEntry` mirrors the journal on the
  period end and the lines return to `PENDING`; a run with a later posted
  run is refused so periods unwind in order.
- **Void guard.** An invoice whose revenue has been recognized cannot be
  voided (`REVENUE_RECOGNIZED`) - reverse the runs first. Otherwise the
  schedules are cancelled and the void reversal itself clears the deferred
  credit.
- **Automatic recognition is opt-in twice.** The job posts only for
  companies with `revenue_settings.autoRecognize` and only lines under
  policies with `autoRecognize`; the run records no user (`createdBy` null,
  "Scheduler").

## Web (`apps/web`)

`/revenue/schedules[/:id]`, `/revenue/runs[/:id]`, `/revenue/reports`,
`/revenue/policies` under the Receivables section ("Revenue" group). The
invoice line editor gains an AR-only popover (`RevenueLinePopover`) for the
policy, service window and milestones; a posted invoice's detail shows its
schedules (`InvoiceRevenueCard`).
