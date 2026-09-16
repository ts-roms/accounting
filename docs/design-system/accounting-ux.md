# Accounting UX patterns

Reusable patterns for financial documents. New modules (payroll, tax filings,
…) should compose these rather than invent their own.

## Document lifecycle timelines (`StepTimeline`)

Builders in `apps/web/components/accounting/timelines.tsx` turn a document
into steps with `complete | current | upcoming | failed | skipped` states,
who/when metadata and a rejection/void reason:

| Document         | Steps                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Journal entry    | Created → Submitted → Approved → Posted (branch: Rejected; suffix: Reversed)                         |
| Invoice / Bill   | Draft → Approved → Posted → Partially paid → Paid (branch: Voided)                                   |
| Payment          | Draft → Posted (branch: Voided)                                                                      |
| Approval request | Submitted → each workflow step (with decisions) → Approved / Rejected / Cancelled                    |
| Period close     | Open → Review → Reconciliation → Adjustments → Approval → Close (checklist tasks in Financial Close) |

Completed steps are emphasised, the current step carries a soft ring,
upcoming steps are muted, failures are red with the reason underneath.

## Posting and approving (`OperationDialog`)

Posting is one server transaction that validates the document, balance,
period, accounts and authority before writing the ledger. The dialog shows
that checklist honestly:

```
POST JOURNAL
JE-2026-000074 will be written to the general ledger for September 2026.

○ Validating document
○ Checking debits and credits
○ Checking accounting period
○ Checking account status
○ Checking authorization
○ Posting to the general ledger

            [Cancel]  [Post to ledger]
```

While the request runs every step shows a spinner and the button reads
"Posting…" (disabled — no duplicate submissions). On success the checks flip
to ✓ with a 60ms stagger and **POSTED** appears; the dialog closes after
~0.9s. On failure the API error code selects the failing step
(`ACCOUNTING_PERIOD_*` → period, `JOURNAL_UNBALANCED` → balance, `FORBIDDEN` /
`SOD_*` / `DELEGATION*` → authorization …), earlier steps are ✓, later ones
stay pending, and the message is shown under the failing step with a Retry.

Use `POSTING_STEPS` for anything that hits `AccountingPostingService`,
`APPROVAL_STEPS` for approvals. Pass a `DelegatedAuthorityNotice` as children
when the action can be performed under delegation.

## Journal entry form

Header → lines → debit/credit totals → **Balanced ✓** (or the difference in
critical tone) → validation messages → submit. Amount cells are tabular and
right-aligned; account pickers show `code name`.

## Status

Business status and accounting status stay separate
(`DocumentStatusBadge` shows `PARTIALLY PAID` with an `UNPOSTED` marker when
relevant). Tones: draft = pending (clock), submitted = warning, approved =
info, posted/paid/reconciled = positive, rejected/void/failed = critical,
reversed/cancelled = neutral.

## Money

Tables: `Amount` (parentheses for negatives, zero as `-` when `zeroAsDash`).
KPIs: `CurrencyDisplay variant="metric"` with symbol and sign. Never colour a
number without a sign.

## Delegated authority

Any approve/post screen renders `DelegatedAuthorityNotice permission=…` above
the action. The banner is informational (blue), lists delegator, scope,
limit and validity, links the delegation number, and turns critical when the
document amount exceeds the delegated limit. Delegated actions must never
look like the user's own authority.

## Reconciliation

Bank statement pages show `ReconciliationCounters` (matched / needs review /
unmatched + progress). Matching a line updates the counters in place; rows do
not animate. The Reconciliation Center and dashboard `FinancialHealth` read
`SubledgerBalancesService` results only.

## Integrations

Integration cards show `● Connected · Last sync 2 minutes ago`; the Sync tab
shows `SyncProgress` (per-entity latest job with live counts) above the job
history. Counters reflect `recordsProcessed`; there is no invented total.

## Financial health

`FinancialHealth` aggregates live control data: integrity checker status,
reconciliation areas within materiality (+ stale), current close progress,
and critical exceptions. The headline is the worst tone (Healthy / Attention
/ Critical). It never computes a synthetic score.
