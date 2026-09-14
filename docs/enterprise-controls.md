# Enterprise controls (hardening phase 5)

Phase 5 turns the controls that already existed in code into things a finance
administrator can see and tune: segregation of duties on documents and as a
standing report, an approval engine with branch scope, deadlines and
escalation, field-level change history, suspense-account monitoring, and one
control dashboard. Nothing here posts; everything reads the ledger and the
audit trail.

## Segregation of duties

Policies (`sod_policies`, per organization) pair two permissions. They are
enforced in two places by `SodService`:

- **Assignment time** - `assertAllowed` before a role assignment: BLOCK
  refuses (`SOD_VIOLATION`), WARN returns warnings that are audited.
- **Document time** - `checkActorSeparation(org, [permA, permB], previousActor,
actor, tx, document)`: the person who performed step A on a document must not
  perform step B. BLOCK throws `SOD_VIOLATION` (422, `details.conflicts`); WARN
  lets the action through and writes a `SOD_WARNING` audit row naming the actor,
  policy and document. Applied to journals (create/approve, approve/post),
  purchase orders, budgets, expense claims and - new in H5 - invoices
  (create/approve), bills (create/approve), vendor payments (create/post) and
  customer receipts (create/post).

`GET /sod-policies/conflicts` (`role.view`) lists every active user whose
effective permissions in some company scope hold both sides of an active policy;
the roles screen shows it under **Segregation of duties → Current conflicts**
and the control dashboard counts it. Default policies are seeded per
organization (`DEFAULT_SOD_POLICIES` in `@accounting/types`); they are data and
may be relaxed or tightened per organization.

## Approval engine

`approval_workflows` gained three columns:

| Column                  | Effect                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `branch_id`             | The workflow only matches documents of that branch; among equal priorities a branch workflow beats a company-wide one. |
| `deadline_hours`        | Copied to `approval_requests.due_at` when a request opens. Past it the request is **overdue**.                         |
| `escalation_permission` | While overdue, holders of this permission may decide the current step in place of the step approvers.                  |

`approval_requests` carry `branch_id`, `due_at` and `escalated_at`.
`ApprovalsService.escalateOverdue` stamps `escalated_at` once and writes an
`ESCALATE` audit row; it runs lazily on every list and dashboard read, so the
approvals inbox is always current without a scheduler. `GET /approvals?overdue=true`
filters; every request view carries `overdue`, `dueAt`, `escalatedAt` and
`escalationPermission`, and `canDecide` honours escalation.

`VENDOR_BILL` joined the workflow document types: bill approval calls
`assertApproved`, voiding cancels the request. Fixed with it: `assertApproved`
now opens the request on its own connection, because the caller's transaction
rolls back with `APPROVAL_REQUIRED` - previously the request opened at
approve/post time (vendor payments) vanished with the rollback.

Delegation of approval authority is being built separately (delegations module)
and is not part of this phase.

## Field-level change history

`field_changes` (append-only, trigger-protected like `audit_logs`) holds one
row per changed top-level field: entity, field, previous / new value, who,
when, reason, correlation id and the audit row it came from. `AuditService.record`
derives the rows whenever an `UPDATE` event carries both a `previousValue` and a
`newValue` object (workflow actions such as approve / post are events, not
edits, and stay in the audit trail only), so every module that audits an update
with before / after gets history for free; `metadata.reason` becomes the row's reason. Invoice and
bill updates audit their full header and accept `changeReason`. Values are
stored wrapped (`{ value }`) because a bare JSON string in jsonb is parsed twice
on the way back.

`GET /history?entityType&entityId[&field]` (`history.view`, company scoped)
returns the rows oldest first; the journal, invoice and bill detail screens show
them in a **Change history** panel next to the attachments.

## Suspense account control

Accounts flagged `is_suspense` (chart of accounts dialog; seed flags 1590 Fixed
Asset Clearing, 1990 Suspense, 2160 GRNI) are expected to return to zero.
`SuspenseService.monitor(companyId, asOf)` walks each account's posted lines in
date order and reports:

- balance as of the date and the number of posted lines,
- the **open items**: lines since the running balance was last zero, and the
  date it left zero (`openSince`) → `ageDays`,
- a status from the company policy: `CLEAR`, `WITHIN_POLICY`, or
  `REQUIRES_INVESTIGATION` when the balance exceeds
  `accounting_policies.suspense_materiality` or is older than
  `suspense_max_age_days`.

It feeds `GET /controls/suspense`, the integrity check `SUSPENSE_BALANCE`
(WARNING) and the close task `SUSPENSE_BALANCES` (blocking when
`closeBlockOnSuspense`, the default). Nothing is stored; the numbers are the
ledger's.

The seed now capitalises the sample equipment bill into the asset register
(`FA-2026-000001`, Dr 1510 / Cr 1590) so the clearing account clears - the
monitor found the 120,000 parked there the first time it ran.

## Integrity checks

Two checks joined the checker (16 in total): `SUSPENSE_BALANCE` and
`TAX_ACCOUNT_INVALID` (active tax codes must map to active, postable accounts).

## Control dashboard

`GET /controls/dashboard?asOf` (`controls.view`) composes ten tiles with a
severity (`OK / INFO / WARNING / CRITICAL`) and a drill-down link: unbalanced
journals, integrity findings, pending approvals (overdue count), reconciliation
variances (stale areas), suspense balance, unresolved exceptions, SoD conflicts
(with warned overrides in the last 30 days), failed accounting jobs (arrives in
H8), the open period and the close progress of its live close.
**Accounting → Control Center** shows the tiles and links every control area
(periods, close, reconciliation, integrity, suspense, mappings, workflows,
approvals, roles / SoD, users, audit trail, tax).

## Permissions

`controls.view` and `history.view` are read permissions and therefore part of
every read role (VIEW_ALL). Everything that changes state keeps its existing
permission (`sod.manage`, `workflow.manage`, `policy.manage`, `account.manage`).

## Known limitations

- Department (dimension) specific approval rules are not implemented; branch
  scope is.
- No responsible person / department per suspense account yet.
- Failed accounting jobs are not tracked until the reliability phase.
- The journal control center (filtered operations view) is deferred to the
  reporting phase.
