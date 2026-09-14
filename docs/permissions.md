# Permissions & Roles

Source of truth: `packages/types/src/permissions.ts`, `roles.ts`, `sod.ts`.
The seed synchronises the catalog and system roles into the database
(`permissions`, `roles`, `role_permissions`, `sod_policies`); re-running the seed
propagates new permissions to system roles.

## Permission keys

Format `<resource>.<action>`. Grouped by module:

| Module         | Keys                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADMINISTRATION | `organization.view/manage`, `company.view/manage`, `branch.view/manage`, `user.view/create/update/deactivate`, `role.view/manage/assign`, `sod.manage`, `workflow.manage`, `approval.view/decide`, `attachment.view/manage`                                                                                                                                        |
| ACCOUNTING     | `account.view/manage`, `journal.view/create/submit/approve/post/reverse`, `period.view/manage/close/reopen/lock/post-soft-closed`, `journal.correct`, `integrity.check`, `reconciliation.view/prepare/approve`, `policy.manage`, `close.view/manage/approve`, `controls.view`, `history.view`, `exchange-rate.view/manage`, `fx.revalue`, `intercompany.view/post` |
| SALES          | `customer.view/manage`, `quotation.view/create`, `sales-order.view/create/approve`, `invoice.view/create/approve/post/void`, `sales-return.view/create/approve`, `customer-payment.create/post`                                                                                                                                                                    |
| PURCHASING     | `vendor.view/manage`, `purchase-request.view/create/approve`, `purchase-order.view/create/approve`, `goods-receipt.view/create`, `bill.view/create/approve/post/void/match-review`, `purchase-return.view/create`, `vendor-payment.create/approve/post`                                                                                                            |
| INVENTORY      | `product.view/manage`, `warehouse.manage`, `inventory.view/adjust`, `inventory-settings.manage`                                                                                                                                                                                                                                                                    |
| BANKING        | `bank-account.view/manage`, `bank-transaction.create/post`, `bank-statement.import`, `bank-reconciliation.perform`                                                                                                                                                                                                                                                 |
| FIXED_ASSETS   | `fixed-asset.view/manage/post`, `depreciation.run`                                                                                                                                                                                                                                                                                                                 |
| BUDGETING      | `budget.view/manage/approve`, `dimension.view/manage`, `expense-claim.view/create/approve/post`                                                                                                                                                                                                                                                                    |
| TAX            | `tax.view/manage`                                                                                                                                                                                                                                                                                                                                                  |
| REPORTING      | `reports.view/export`, `consolidation.view`                                                                                                                                                                                                                                                                                                                        |
| AUDIT          | `audit.view`                                                                                                                                                                                                                                                                                                                                                       |
| AI             | `ai.view/use/review` (advisory features: intake, classification, anomaly flags, assistant, forecast)                                                                                                                                                                                                                                                               |

Adding a permission: append to `PERMISSION_DEFINITIONS`, add it to the relevant
system roles, rebuild `@accounting/types`, run `pnpm db:seed`. Controllers
reference keys through the typed `P` map (`P['journal.post']`), so typos fail
at compile time.

## System roles

| Role                                 | Intent                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `SUPER_ADMIN`                        | Everything. Permission set is fixed (cannot be edited); at least one active holder must remain.      |
| `ACCOUNTING_ADMIN`                   | Configuration, users/roles, periods, full journal lifecycle, audit trail.                            |
| `ACCOUNTANT`                         | Prepares journals, invoices, bills, payments; cannot approve or post.                                |
| `FINANCE_MANAGER`                    | Approves and posts, reverses, closes periods, runs depreciation and reconciliation, approves closes. |
| `AUDITOR`                            | Read-only everywhere including the audit trail.                                                      |
| `CASHIER`                            | Customer receipts and bank account visibility.                                                       |
| `SALES` / `PURCHASING` / `INVENTORY` | Operational master data and documents for their area.                                                |
| `MANAGER`                            | Read-only plus approval of invoices and bills.                                                       |
| `VIEWER`                             | Read-only (no audit trail).                                                                          |

System roles other than `SUPER_ADMIN` may have their permissions adjusted per
organization; custom roles can be created freely.

## Assignment scope

- Organization-wide (`companyId = null`): applies to all companies.
- Company-scoped: only effective while that company is active
  (`X-Company-Id`). Effective permissions = union of both.

## Segregation of duties

Default policies (all `WARN`; an administrator may switch any to `BLOCK`):

| Policy                                  | Conflict                                         |
| --------------------------------------- | ------------------------------------------------ |
| Journal creator vs approver             | `journal.create` + `journal.approve`             |
| Journal approver vs poster              | `journal.approve` + `journal.post`               |
| Vendor bill creator vs payment approver | `bill.create` + `vendor-payment.approve`         |
| Vendor master vs vendor payment         | `vendor.manage` + `vendor-payment.post`          |
| Period close vs period reopen           | `period.close` + `period.reopen`                 |
| Expense claim submitter vs approver     | `expense-claim.create` + `expense-claim.approve` |

`SodService.evaluate()` is pure and unit-tested; `assertAllowed()` is invoked
before every assignment with the permission set the user _would_ hold in the
target scope. Warnings are returned to the caller and stored in the audit entry.
Document-level checks use the same policy data: a journal, claim or approval
step is never approved by the person who created or submitted it, and
approval workflows add four-eyes rules (one decision per person per request,
`allowSelfApproval` off by default).
