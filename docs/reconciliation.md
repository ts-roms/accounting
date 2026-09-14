# Subledger reconciliation

How each subledger is tied to the general ledger, how a reconciliation is
recorded and controlled, and what the numbers mean. Bank reconciliation
(statement lines against bank transactions) is a separate, document-level
process described in [accounting-engine.md](accounting-engine.md#fixed-assets-and-banking-phase-6).

## The relationships

| Area           | Subledger (expected)                                                               | Ledger (actual)                                                       |
| -------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `AR`           | open invoices / notes in base at document rate − receipts at settlement value + FX | `ACCOUNTS_RECEIVABLE` control balance                                 |
| `AP`           | same, for bills and vendor payments                                                | `ACCOUNTS_PAYABLE` control balance                                    |
| `INVENTORY`    | costed on-hand layers per inventory account                                        | each inventory account's balance                                      |
| `FIXED_ASSETS` | register cost per asset account; register accumulated depreciation (as a credit)   | the mapped / category asset and accumulated accounts, always compared |
| `TAX`          | signed tax register (`tax_transactions`) per tax account                           | movements on those accounts from document-sourced journals only       |

`SubledgerBalancesService.compute(company, area, asOf)` is the single
implementation of the "expected" side; the integrity checker and the recorded
reconciliations both call it, so they can never disagree.

Tax deserves a note: remittances, opening balances and other manual journals
also move the tax accounts but are not tax-register events, so they are
excluded from the comparison and reported per account as _other movements_.
The reconciliation therefore proves that every document posting recorded its
tax, which is the control that matters.

## Recorded reconciliations

`POST /reconciliations { area, asOf }` snapshots the computation into a
`reconciliations` row (one per company / area / control account / date) with
the policy materiality in force, the breakdown lines and who prepared it.

```text
IN_PROGRESS ──compute──▶ RECONCILED      (|variance| ≤ materiality)
                     └─▶ HAS_VARIANCE    (otherwise)
            ──assign───▶ UNDER_REVIEW    (reviewer named)
            ──approve──▶ APPROVED        (final; recompute refused)
```

Approval (`reconciliation.approve`) is refused when:

- the approver prepared the reconciliation (`SOD_VIOLATION`);
- any exception is still `OPEN` (`RECONCILIATION_UNRESOLVED`);
- the _unexplained_ variance — variance minus the signed sum of logged
  exceptions — exceeds materiality (`RECONCILIATION_UNRESOLVED`, with the
  figures in `details`).

So a material variance is never silently completed: it is either corrected in
the books (recompute), or explained by exceptions that name the cause and are
resolved, or the company's materiality policy explicitly covers it.

Exceptions (`POST /reconciliations/:id/exceptions`) carry a description, the
signed amount they explain and a reference; resolving one records who, when
and how. Notes are appended with a timestamp and author. Every transition is
audited (`CREATE` / `UPDATE` / `RECONCILIATION_APPROVE`). Attachments can be
added to a reconciliation (`attachments/RECONCILIATION/:id`).

## Policy

`GET/PATCH /accounting-policies` (`policy.manage`) holds per-company controls:

- `reconciliationMateriality` — absolute base-currency variance treated as
  reconciled (default `0`);
- `reconciliationStaleDays` — after this many days a recorded reconciliation
  counts as stale in the summary (default 35).

## Reconciliation Center

Accounting → Reconciliation Center renders the summary: one tile per area
(live subledger / ledger / variance, latest recorded status, stale flag,
Run / Open latest), one tile per bank account (ledger balance, latest statement
state, unmatched / possible / exception counts, link to the statement
workspace), the policy dialog and the list of recorded reconciliations. The
detail page shows the account lines with drill-down to the general ledger,
the review panel (preparer, reviewer, approver, notes), exceptions with
resolve, attachments and the Approve action - which only appears for someone
other than the preparer.

## Bank matching confidence

The bank matching engine scores every automatic match: **HIGH** when amount,
date window and a reference agree, **MEDIUM** for a unique amount / date hit.
(default MEDIUM) is the control
rule: below the bar a statement line becomes with the
suggested ledger line for a person to confirm, and the candidate is not
consumed. Nothing uncertain is reconciled automatically.

## Reconciliation Center

Accounting → Reconciliation Center renders the summary: one tile per area
(live subledger / ledger / variance, latest recorded status, stale flag,
Run / Open latest), one tile per bank account (ledger balance, latest
statement state, unmatched / possible / exception counts, link to the
statement workspace), the policy dialog and the list of recorded
reconciliations. The detail page shows the account lines with drill-down to
the general ledger, the review panel (preparer, reviewer, approver, notes),
exceptions with resolve, attachments and the Approve action - which only
appears for someone other than the preparer.

## Bank matching confidence

The bank matching engine scores every automatic match: **HIGH** when amount,
date window and a reference agree, **MEDIUM** for a unique amount / date hit.
`banking_settings.autoMatchMinConfidence` (default MEDIUM) is the control
rule: below the bar a statement line becomes `POSSIBLE_MATCH` with the
suggested ledger line for a person to confirm, and the candidate is not
consumed. Nothing uncertain is reconciled automatically.

## The summary

`GET /reconciliations/summary?asOf` returns one row per area with the latest
record, the live figures as of the date, whether the live variance is within
materiality and whether the latest record is stale — the data behind the
Reconciliation Center (hardening phase 3).

## Permissions

`reconciliation.view` (all read roles), `reconciliation.prepare` (accountant,
finance manager, accounting admin), `reconciliation.approve` (finance
manager, accounting admin), `policy.manage` (accounting admin).
