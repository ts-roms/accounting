# Delegated authority

Source: `apps/api/src/modules/delegations/`. A delegation lends a subset of the
delegator's **approval** permissions to another user for a bounded window,
scoped to one company (optionally a branch) and capped by amount. It is never a
role change, and every use is recorded against the original authority.

## Model

```
delegations            DLG-000123, delegator, delegate, company, start/end, status, reason,
                       requiredApprovals (policy snapshot), approvedBy/At, revokedBy/At, usageCount
delegation_scopes      permission, branchId (null = all), maxAmount + currency (null = delegator's own limit)
delegation_approvals   one decision per approver (APPROVE / REJECT, comment)
delegation_usage       one row per exercised approval: delegate, delegator, permission, action,
                       document type / id / number, amount, correlation id
delegation_policies    per organization: approval policy, max duration, expiry warning, revalidate-at-use
```

Statuses: `PENDING -> ACTIVE -> EXPIRED`, `PENDING -> REJECTED | CANCELLED`,
`ACTIVE | PENDING -> REVOKED`.

Delegable permissions (`DELEGABLE_PERMISSIONS` in `packages/types`) are
approval-type only: `bill.approve`, `vendor-payment.approve`,
`invoice.approve`, `expense-claim.approve`, `purchase-request.approve`,
`purchase-order.approve`, `purchase-return.approve`, `sales-order.approve`,
`sales-return.approve`, `journal.approve`, `budget.approve`, `approval.decide`.
Posting, configuration and administration permissions cannot be delegated.

## Rules and where they are enforced

| #  | Rule                                                        | Enforcement                                                      |
| -- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| 1  | Cannot delegate a permission you do not hold                | `create`: delegator's resolved permissions (no chaining)         |
| 2  | Delegate never exceeds the delegator                        | Same check; re-validated at use when `revalidateAtUse`           |
| 3  | Explicit start and end                                      | Schema + `validateWindow` (future, <= policy max days)           |
| 4  | Expired delegations stop automatically                      | Window check in `grantsFor` / `checkGrant`; job marks EXPIRED    |
| 5  | Revoked delegations stop immediately                        | Status re-read `FOR UPDATE` inside the approving transaction     |
| 6  | Company and branch scope                                    | Grants resolved per active company; branch compared per document |
| 7  | Monetary limits                                             | Exact-decimal `Money` compare, currency must match               |
| 8  | Segregation of duties                                       | `SodService.assertAllowed` on the delegate's combined permissions at creation |
| 9  | No self-approval                                            | Document creator == acting user is refused; delegator cannot use own delegation |
| 10 | Never bypasses accounting controls                          | Only "may this person approve" is answered; posting is untouched |

## Approval policy

`PUT /delegations/policy` - `SELF_SERVICE` (active immediately),
`MANAGER_APPROVAL` (one holder of `delegation.approve`), `ADMIN_APPROVAL`
(one holder of `delegation.manage`), `DUAL_APPROVAL` (two distinct approvers).
Parties to a delegation can never approve it.

## Approval engine integration

```
Transaction -> required permission
  -> actor holds it natively?            yes: proceed (nothing recorded)
  -> active delegation for it?           PermissionsGuard accepts, then in the service:
       AuthorityService.assert(tx, actor, permission, document)
         window, company, branch, amount, currency, self-approval, delegator-self
         delegation row re-read FOR UPDATE (ACTIVE, in window)
         delegator still holds the permission (policy.revalidateAtUse)
         delegation_usage row + audit DELEGATION_USE
  -> approve / reject
```

Wired into: vendor bills, customer invoices, expense claims, sales / purchase
orders and requests, sales / purchase returns, journal entries, budget versions
and workflow approval decisions (`ApprovalsService.decide`).

The audit entry written on use names both sides explicitly:

```json
{
  "originalAuthority": { "userId": "...", "name": "Marco Santos" },
  "actingUser": { "userId": "...", "email": "accountant@acme.local", "name": "Ana Reyes" },
  "delegation": "DLG-000001",
  "permission": "bill.approve",
  "action": "Approved vendor bill",
  "document": { "type": "VENDOR_BILL", "number": "BILL-2026-000031", "amount": "120000.0000", "currency": "PHP" },
  "reason": "Leave coverage: AP bill approval while the Finance Manager is away",
  "validUntil": "2026-09-28T..."
}
```

The document's own `APPROVE` audit entry carries the same block under
`metadata.delegatedAuthority`, so nothing ever looks as if the delegate were
the original approver.

## UX

`/auth/me` returns `delegations` (active grants for the active company).
Approval screens (subledger document detail, workflow approvals) render
`DelegatedAuthorityNotice` above the action - delegated from, delegation
number, valid until, limit, and a red warning when the document exceeds the
limit. The Delegated Authority dashboard (`/admin/delegations`) has sections
for my delegations, delegations I created, delegations I approve, active,
pending and expired, plus creation, approval, revocation and usage history.

## Endpoints

```
GET    /delegations                 (?role=delegate|delegator|approver, status, companyId, permission)
POST   /delegations
GET    /delegations/:id
PATCH  /delegations/:id             (PENDING only)
POST   /delegations/:id/approve     { decision: APPROVE | REJECT, comment }
POST   /delegations/:id/revoke      { reason }
POST   /delegations/:id/cancel
GET    /delegations/:id/usage
GET    /delegations/active | /pending | /my-authority | /permissions | /policy
PUT    /delegations/policy
```
