# Financial close (hardening phase 4)

A close is a governed checklist for one fiscal period. It is the only path that
closes a period from the UI: the period closes (and optionally locks) when the
close is completed, and the close can only be completed once every blocker is
clear and management has approved it. Code: `apps/api/src/modules/financial-close`,
web `components/controls/financial-close.tsx`.

## Lifecycle

```
IN_PROGRESS ─(all required tasks done)─▶ READY ─(close.approve)─▶ APPROVED ─(period.close)─▶ COMPLETED
     ▲                                     │                          │
     └────────── regression on refresh ────┴──────────────────────────┘        any live state ─▶ CANCELLED
```

- `POST /financial-closes { fiscalPeriodId, closeType? }` starts a close for an
  OPEN or SOFT_CLOSED period. One live (IN_PROGRESS / READY / APPROVED) close per
  period is enforced by a partial unique index; completed and cancelled closes stay
  as the trail, so a reopened period can be closed again.
- The checklist is instantiated from a template: 17 tasks for a month or quarter,
  18 for a year end (`MANUAL_YEAR_END_ADJUSTMENTS`). Tasks are `AUTO` (evaluated
  from ledger data on every refresh; nobody can tick them) or `MANUAL` (worked by
  people: status, owner, reviewer, notes; skipping a required task needs a reason).
  Custom manual tasks can be added to any live close.
- `refresh` re-evaluates the automatic checks, rewrites the blocker snapshot, moves
  IN_PROGRESS ↔ READY, and **withdraws an APPROVED close** that regressed (a new
  unposted journal, a reopened exception, ...) so approval always reflects the
  current state of the books.
- `approve` needs `close.approve`, a READY close, no blockers and no pending
  required task; otherwise `CLOSE_BLOCKED` (422) with `details.blockers` and
  `details.pendingTasks`.
- `complete` needs `period.close` and an APPROVED close. Inside one transaction it
  closes the period (sequence rules of `FiscalPeriodsService` apply), closes the
  fiscal year for a `YEAR` close, locks the period when
  `closeLockOnComplete` is set, marks the close COMPLETED and writes a
  `PERIOD_CLOSE` audit row.

## Automatic checks and the policy

| Check                                             | Passes when                                                                                                 | Policy flag                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `AR/AP/INVENTORY/FIXED_ASSETS/TAX_RECONCILIATION` | an APPROVED subledger reconciliation exists as of the period end                                            | `closeRequireReconciliations`    |
| `BANK_RECONCILIATION`                             | every active bank account has a completed reconciliation on a statement in the period, or has no statements | `closeRequireBankReconciliation` |
| `DEPRECIATION`                                    | a posted depreciation run covers the period, or there are no active assets                                  | `closeRequireDepreciation`       |
| `FX_REVALUATION`                                  | an FX revaluation was posted in the period (informational by default)                                       | `closeRequireFxRevaluation`      |
| `UNAPPROVED_JOURNALS`                             | no DRAFT / SUBMITTED / APPROVED journals dated in the period                                                | `closeBlockOnUnapprovedJournals` |
| `OPEN_RECONCILIATION_EXCEPTIONS`                  | no open exception on a reconciliation as of the period end                                                  | `closeBlockOnOpenExceptions`     |
| `TRIAL_BALANCE`                                   | the posted trial balance as of the period end balances                                                      | always blocking                  |
| `INTEGRITY`                                       | every financial integrity check passes                                                                      | `closeRequireIntegrityOk`        |

A failed check whose flag is off is reported (task `BLOCKED`, blocker
`blocking: false`) but does not stop approval. Flags live in
`accounting_policies` and are edited through `PATCH /accounting-policies`
(`policy.manage`); the audit row keeps the full before / after.

`GET /financial-closes/blockers?fiscalPeriodId` evaluates the checks for a period
without starting a close (the period-closing screen and pre-close review).

## Permissions

`close.view` (all read roles), `close.manage` (accountant, finance manager,
accounting admin), `close.approve` (finance manager, accounting admin).
Completing still needs `period.close`, so the close cannot bypass period
authority; four-eyes between preparer and approver is left to role design
(phase 5 adds segregation-of-duties rules).

## Known limitations

- No scheduled reminders or task due dates; owners are assigned but not notified.
- The template is fixed in code; per-company templates are a phase 5+ candidate.
- Consolidated (multi-company) closes are out of scope until phase 9.
