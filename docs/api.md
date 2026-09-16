# API

Base path: `/api/v1` (URI versioning). OpenAPI UI: `http://localhost:3001/api/docs`
(non-production only), JSON at `/api/docs-json`.

## Conventions

- JSON in/out. Monetary values (from Phase 2) are decimal **strings**.
- Every request/response carries `x-correlation-id` (generated when absent).
- Pagination: `?page=1&pageSize=25&sortBy=...&sortDir=asc|desc&search=...` ->
  `{ items, page, pageSize, total, totalPages }`. `pageSize` max 200.
- Company context: `X-Company-Id: <uuid>` selects the active legal entity.
  Endpoints marked `@CompanyScoped()` require it.
- CSRF: every non-GET request authenticated by cookie must send
  `X-Requested-With: XMLHttpRequest`.

## Error envelope

```json
{
  "code": "ACCOUNTING_PERIOD_CLOSED",
  "message": "The selected accounting period is closed.",
  "details": {},
  "correlationId": "5b0e..."
}
```

| HTTP | Codes                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED` (`details.issues` = Zod issues)                                                                                |
| 401  | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `ACCOUNT_LOCKED`, `ACCOUNT_INACTIVE`                                  |
| 403  | `FORBIDDEN`, `PERMISSION_DENIED` (`details.required`), `CSRF_HEADER_MISSING`, `COMPANY_CONTEXT_REQUIRED`, `COMPANY_NOT_ACCESSIBLE` |
| 404  | `NOT_FOUND`                                                                                                                        |
| 409  | `CONFLICT`, `DUPLICATE`                                                                                                            |
| 422  | `SOD_VIOLATION` (`details.conflicts`), `SYSTEM_ROLE_IMMUTABLE`, `LAST_SUPER_ADMIN`                                                 |
| 429  | `RATE_LIMITED`                                                                                                                     |
| 500  | `INTERNAL_ERROR` (never exposes internals)                                                                                         |

## Endpoints (Phase 1)

### Auth

| Method | Path                    | Notes                                                                                                                  |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`           | Public. Body `{ email, password }`. Sets `acct_access` (15 min) and `acct_refresh` (7 d) httpOnly cookies. 10 req/min. |
| POST   | `/auth/refresh`         | Public. Rotates the refresh token; reuse of a rotated token revokes all sessions.                                      |
| POST   | `/auth/logout`          | Revokes the current session, clears cookies.                                                                           |
| GET    | `/auth/me`              | User, organization, effective permissions for the active company, role keys, accessible companies.                     |
| POST   | `/auth/change-password` | Revokes other sessions.                                                                                                |

### Organization

| Method     | Path                                    | Permission                                  |
| ---------- | --------------------------------------- | ------------------------------------------- |
| GET/PATCH  | `/organization`                         | `organization.view` / `organization.manage` |
| GET        | `/companies`, `/companies/:id`          | `company.view`                              |
| POST/PATCH | `/companies`, `/companies/:id`          | `company.manage`                            |
| GET        | `/branches?companyId=`, `/branches/:id` | `branch.view`                               |
| POST/PATCH | `/branches`, `/branches/:id`            | `branch.manage`                             |

### Users & roles

| Method   | Path                                                                          | Permission        |
| -------- | ----------------------------------------------------------------------------- | ----------------- |
| GET      | `/users` (paginated, `status`, `search`)                                      | `user.view`       |
| POST     | `/users` (with `roleIds`)                                                     | `user.create`     |
| PATCH    | `/users/:id`                                                                  | `user.update`     |
| PATCH    | `/users/:id/status`                                                           | `user.deactivate` |
| GET      | `/users/:id/roles`                                                            | `user.view`       |
| POST     | `/users/:id/roles` `{ roleId, companyId? }` -> `{ assignmentId, warnings[] }` | `role.assign`     |
| DELETE   | `/users/:id/roles/:assignmentId`                                              | `role.assign`     |
| GET      | `/permissions`, `/roles`, `/roles/:id`                                        | `role.view`       |
| POST     | `/roles`                                                                      | `role.manage`     |
| PATCH    | `/roles/:id`                                                                  | `role.manage`     |
| PUT      | `/roles/:id/permissions`                                                      | `role.manage`     |
| GET      | `/sod-policies`                                                               | `role.view`       |
| POST/PUT | `/sod-policies`, `/sod-policies/:id`                                          | `sod.manage`      |
| GET      | `/sod-policies/conflicts` - users holding both sides of an active policy      | `role.view`       |

### Accounting (all require `X-Company-Id`)

| Method                | Path                                                                                                                                                                                                                   | Permission                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| GET                   | `/accounts` (`type`, `status`, `search`, `postableOnly`) - depth-first tree with `level`                                                                                                                               | `account.view`                    |
| POST / PATCH / DELETE | `/accounts`, `/accounts/:id` (delete only when unused)                                                                                                                                                                 | `account.manage`                  |
| GET / PUT             | `/accounts/mappings` `{ key, accountId or null }`                                                                                                                                                                      | `account.view` / `account.manage` |
| GET                   | `/fiscal-years` (with periods)                                                                                                                                                                                         | `period.view`                     |
| POST                  | `/fiscal-years` `{ startDate, name? }`                                                                                                                                                                                 | `period.manage`                   |
| POST                  | `/fiscal-years/:id/close` (year-end closing entry)                                                                                                                                                                     | `period.close`                    |
| POST                  | `/fiscal-periods/:id/soft-close` `{ reason? }`, `/fiscal-periods/:id/close` `{ reason? }`                                                                                                                              | `period.close`                    |
| POST                  | `/fiscal-periods/:id/reopen` `{ reason }` (reason mandatory, never from LOCKED), `/fiscal-periods/:id/lock`                                                                                                            | `period.reopen` / `period.lock`   |
| GET                   | `/journal-entries` (paginated; `status`, `journalType`, `from`, `to`, `fiscalPeriodId`, `accountId`, `search`)                                                                                                         | `journal.view`                    |
| GET                   | `/journal-entries/:id` (lines, actors, reversal links)                                                                                                                                                                 | `journal.view`                    |
| POST / PATCH / DELETE | `/journal-entries`, `/journal-entries/:id` (drafts; `idempotencyKey` supported)                                                                                                                                        | `journal.create`                  |
| POST                  | `/journal-entries/:id/submit`                                                                                                                                                                                          | `journal.submit`                  |
| POST                  | `/journal-entries/:id/approve`, `/reject` `{ reason }`                                                                                                                                                                 | `journal.approve`                 |
| POST                  | `/journal-entries/:id/post` (idempotent)                                                                                                                                                                               | `journal.post`                    |
| POST                  | `/journal-entries/:id/reverse` `{ reversalDate, description? }`                                                                                                                                                        | `journal.reverse`                 |
| POST                  | `/journal-entries/:id/correct` `{ reversalDate, correctionDate?, reason }` -> `{ original, reversal, correction }` (reversal posted, correcting DRAFT opened, linked via `correctionOfId`; detail carries `related[]`) | `journal.correct`                 |
| GET                   | `/general-ledger?accountId&from&to&branchId&page&pageSize`                                                                                                                                                             | `journal.view`                    |
| GET                   | `/reports/trial-balance?from&to&includeZero`                                                                                                                                                                           | `reports.view`                    |
| GET                   | `/reports/income-statement?from&to`                                                                                                                                                                                    | `reports.view`                    |
| GET                   | `/reports/balance-sheet?asOf`                                                                                                                                                                                          | `reports.view`                    |

Amounts are decimal strings with up to 4 fractional digits; dates are `YYYY-MM-DD`.
Accounting error codes (422): `JOURNAL_UNBALANCED` (`details.difference`), `JOURNAL_INVALID_STATE`,
`ACCOUNT_NOT_POSTABLE`, `GL_ACCOUNT_INACTIVE`, `ACCOUNT_HAS_ACTIVITY`, `ACCOUNT_HIERARCHY_INVALID`,
`ACCOUNT_MAPPING_MISSING`, `CURRENCY_MISMATCH`, `ACCOUNTING_PERIOD_CLOSED`, `ACCOUNTING_PERIOD_NOT_FOUND`,
`PERIOD_SEQUENCE_VIOLATION`, `PERIOD_HAS_UNPOSTED_ENTRIES`, `FISCAL_YEAR_OVERLAP`, `FISCAL_YEAR_CLOSED`, `SOD_VIOLATION`.

### Receivables (all require `X-Company-Id`)

| Method                | Path                                                                                                                                  | Permission                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| GET                   | `/customers` (paginated; `status`, `search`) - each row carries `balance { outstanding, overdue, unappliedCredit, net }`              | `customer.view`           |
| GET                   | `/customers/:id`, `/customers/:id/statement?from&to`                                                                                  | `customer.view`           |
| POST / PATCH          | `/customers`, `/customers/:id`                                                                                                        | `customer.manage`         |
| GET                   | `/invoices` (paginated; `partyId`, `documentType`, `status`, `from`, `to`, `openOnly`, `overdueOnly`, `search`)                       | `invoice.view`            |
| GET                   | `/invoices/:id` (lines, allocations, journal links)                                                                                   | `invoice.view`            |
| POST / PATCH / DELETE | `/invoices`, `/invoices/:id` (drafts; `documentType` INVOICE / CREDIT_NOTE / DEBIT_NOTE; `idempotencyKey`; returns `warnings[]`)      | `invoice.create`          |
| POST                  | `/invoices/:id/approve`                                                                                                               | `invoice.approve`         |
| POST                  | `/invoices/:id/post` (idempotent; Dr AR control / Cr line accounts, mirrored for credit notes)                                        | `invoice.post`            |
| POST                  | `/invoices/:id/void` `{ reason, reversalDate? }` (reversal journal when posted; rejected once settled)                                | `invoice.void`            |
| POST                  | `/invoices/:id/apply` `{ allocations: [{ documentId, amount }] }` (posted credit note -> open documents, no ledger effect)            | `customer-payment.post`   |
| PATCH                 | `/invoices/:id/collection` `{ promisedPaymentDate?, collectionNotes? }`                                                               | `invoice.create`          |
| GET                   | `/customer-payments` (paginated; `partyId`, `status`, `from`, `to`, `search`), `/customer-payments/:id`                               | `invoice.view`            |
| POST / PATCH / DELETE | `/customer-payments`, `/customer-payments/:id` (drafts; `paymentType` PAYMENT / REFUND, `cashAccountId`, `allocations[]`)             | `customer-payment.create` |
| POST                  | `/customer-payments/:id/post` (Dr cash / Cr AR, applies allocations; refunds mirror and are capped by unapplied credit)               | `customer-payment.post`   |
| POST                  | `/customer-payments/:id/allocate` `{ allocations }` (on-account remainder), `/customer-payments/:id/void` `{ reason, reversalDate? }` | `customer-payment.post`   |
| GET                   | `/reports/ar-aging?asOf&partyId`, `/reports/ar-reconciliation?asOf`                                                                   | `reports.view`            |

### Payables (all require `X-Company-Id`)

Mirror of the receivables routes: `/vendors` (`vendor.view` / `vendor.manage`),
`/bills` (`bill.view` / `bill.create` / `bill.approve` / `bill.post` / `bill.void`;
bills carry `vendorInvoiceNumber` and `scheduledPaymentDate`, `PATCH /bills/:id/schedule`
replaces `/collection`), `/vendor-payments` (`vendor-payment.create` / `vendor-payment.post`;
posting is Dr AP / Cr cash), `/reports/ap-aging`, `/reports/ap-reconciliation` and
`/reports/ap-schedule?to` (open bills ordered by scheduled or due date).

Subledger error codes (422): `DOCUMENT_INVALID_STATE`, `DOCUMENT_HAS_ALLOCATIONS`,
`ALLOCATION_EXCEEDS_BALANCE`, `PARTY_INACTIVE`, `DUPLICATE_VENDOR_INVOICE` (409).
Non-blocking warnings returned as `warnings[{ code, message, details }]`:
`CREDIT_LIMIT_EXCEEDED`, `POSSIBLE_DUPLICATE_BILL`.

### Sales & purchasing (all require `X-Company-Id`)

Four order resources share one shape: `/quotations`, `/sales-orders`,
`/purchase-requests`, `/purchase-orders` (view / create / approve permissions
`quotation.*`, `sales-order.*`, `purchase-request.*`, `purchase-order.*`).

| Method                      | Path                                                                                                               | Notes                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                         | `/<orders>` (paginated; `partyId`, `status`, `from`, `to`, `openOnly`, `search`), `/<orders>/:id`                  | detail carries lines with `remainingToReceive/Bill/Return` and the documents raised                                                                                                |
| POST / PATCH / DELETE       | `/<orders>`, `/<orders>/:id` (drafts; lines `{ description, quantity, unitPrice, discountPercent, accountId }`)    | sales documents need `customerId`, purchase orders `vendorId`, requests may omit it                                                                                                |
| POST                        | `/<orders>/:id/submit` \| `send` \| `accept` \| `approve` \| `reject { reason }` \| `close` \| `cancel { reason }` | only the transitions valid for the type; approval returns `sodWarnings[]`                                                                                                          |
| POST                        | `/quotations/:id/convert`, `/purchase-requests/:id/convert { vendorId?, orderDate?, expectedDate? }`               | creates the draft sales / purchase order                                                                                                                                           |
| POST                        | `/sales-orders/:id/fulfil`, `/purchase-orders/:id/fulfil`                                                          | `{ documentDate, dueDate?, vendorInvoiceNumber?, lines?: [{ orderLineId, quantity, unitPrice? }] }` -> draft invoice / bill (`invoice.create` / `bill.create`)                     |
| GET / POST / PATCH / DELETE | `/goods-receipts` (`purchaseOrderId`, `vendorId`, `status`), `/goods-receipts/:id`                                 | `goods-receipt.view` / `goods-receipt.create`                                                                                                                                      |
| POST                        | `/goods-receipts/:id/confirm`, `/goods-receipts/:id/cancel { reason }`                                             | confirm adds received quantities and re-matches the PO's bills                                                                                                                     |
| GET / POST / PATCH / DELETE | `/sales-returns`, `/purchase-returns` (`orderId`, `partyId`, `status`), `/:id`                                     | `sales-return.*` / `purchase-return.*`; lines `{ orderLineId, quantity, reason? }`                                                                                                 |
| POST                        | `/<returns>/:id/approve`, `/<returns>/:id/credit { documentDate? }`, `/<returns>/:id/cancel { reason }`            | credit raises the draft credit note through AR / AP                                                                                                                                |
| GET / PUT                   | `/purchasing/settings`                                                                                             | tolerances (`priceTolerancePercent`, `quantityTolerancePercent`, `overReceiptTolerancePercent`), `requirePurchaseOrder`, `requireReceiptBeforeBill` (`purchasing-settings.manage`) |
| POST                        | `/bills/:id/match-review { note }`                                                                                 | `bill.match-review`; lifts the payment hold on an EXCEPTION bill                                                                                                                   |

Bills expose `purchaseOrderId`, `matchStatus` (`NOT_REQUIRED` / `MATCHED` /
`EXCEPTION` / `REVIEWED`) and `matchExceptions[{ code, message, lineNumber?, details }]`;
invoice / bill lines carry `discountPercent` and `orderLineId`. Order error codes
(422): `ORDER_INVALID_STATE`, `ORDER_LINE_OVERFULFILLED`, `MATCH_EXCEPTION_UNREVIEWED`.

### Inventory (all require `X-Company-Id`)

| Method                      | Path                                                                                                      | Permission                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| GET                         | `/products` (paginated; `status`, `productType`, `categoryId`, `belowReorder`, `search`), `/products/:id` | `product.view`                                 |
| POST / PATCH                | `/products`, `/products/:id` (type / tracking / costing locked while stock exists)                        | `product.manage`                               |
| GET                         | `/products/:id/stock-card?warehouseId&from&to` (movements with running balance)                           | `inventory.view`                               |
| GET / POST / PATCH          | `/product-categories`, `/product-categories/:id`                                                          | `product.view` / `product.manage`              |
| GET / POST / PATCH          | `/warehouses`, `/warehouses/:id`; POST `/warehouses/:id/locations`                                        | `inventory.view` / `warehouse.manage`          |
| GET / PUT                   | `/inventory/settings` `{ defaultCostingMethod, allowNegativeStock }`                                      | `inventory.view` / `inventory-settings.manage` |
| GET                         | `/inventory/stock-on-hand?warehouseId&productId&categoryId&search&includeZero`                            | `inventory.view`                               |
| GET                         | `/inventory/valuation?asOf` (subledger vs. inventory account(s), by warehouse)                            | `inventory.view`                               |
| GET / POST / PATCH / DELETE | `/stock-adjustments`, `/stock-transfers`, `/stock-counts`, `/:id`                                         | `inventory.view` / `inventory.adjust`          |
| POST                        | `/<stock-documents>/:id/post`, `/<stock-documents>/:id/cancel { reason }`                                 | `inventory.post` / `inventory.adjust`          |

Stock-moving lines on invoices, bills, orders, receipts and returns accept
`productId`, `warehouseId`, `lotNumber`, `serialNumbers[]`; posted lines carry
`costAmount`. Inventory error codes (422): `INSUFFICIENT_STOCK`,
`STOCK_IDENTITY_REQUIRED`, `SERIAL_UNAVAILABLE`.

### Fixed assets (all require `X-Company-Id`)

| Method                      | Path                                                                                                              | Permission                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| GET / POST / PATCH          | `/asset-categories`, `/asset-categories/:id`                                                                      | `fixed-asset.view` / `fixed-asset.manage` |
| GET / POST / PATCH / DELETE | `/fixed-assets` (paginated; `status`, `categoryId`, `search`), `/fixed-assets/:id` (events, schedule)             | `fixed-asset.view` / `fixed-asset.manage` |
| GET / PUT                   | `/fixed-assets/settings` `{ autoPostDepreciation }`                                                               | `fixed-asset.view` / `fixed-asset.manage` |
| POST                        | `/fixed-assets/:id/capitalize { creditAccountId?, postingDate? }`                                                 | `fixed-asset.post`                        |
| POST                        | `/fixed-assets/:id/transfer`, `/impair`, `/revalue`, `/dispose`                                                   | `fixed-asset.post`                        |
| GET                         | `/depreciation-runs` (paginated; `status`), `/depreciation-runs/:id`, `/depreciation-runs/preview?fiscalPeriodId` | `fixed-asset.view`                        |
| POST / DELETE               | `/depreciation-runs { fiscalPeriodId }`, `/depreciation-runs/:id`                                                 | `depreciation.run`                        |
| POST                        | `/depreciation-runs/:id/post`, `/depreciation-runs/:id/reverse { reason }`, `/depreciation-runs/scheduled`        | `depreciation.run`                        |

### Banking (all require `X-Company-Id`)

| Method                      | Path                                                                                                                                                   | Permission                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| GET / POST / PATCH          | `/bank-accounts`, `/bank-accounts/:id` (ledger balance, open statements)                                                                               | `bank-account.view` / `bank-account.manage`     |
| GET / PUT                   | `/bank-accounts/settings` `{ matchDateToleranceDays }`                                                                                                 | `bank-account.view` / `bank-account.manage`     |
| GET / POST / PATCH / DELETE | `/bank-transactions` (paginated; `bankAccountId`, `status`, `from`, `to`), `/bank-transactions/:id`                                                    | `bank-account.view` / `bank-transaction.create` |
| POST                        | `/bank-transactions/:id/post`, `/bank-transactions/:id/void { reason }`                                                                                | `bank-transaction.post`                         |
| GET                         | `/bank-statements` (paginated; `bankAccountId`), `/bank-statements/:id`, `/:id/lines?status`, `/:id/ledger-lines?onlyUnmatched`, `/:id/reconciliation` | `bank-account.view`                             |
| POST                        | `/bank-statements { bankAccountId, statementDate, openingBalance, closingBalance, lines[] }`                                                           | `bank-statement.import`                         |
| POST                        | `/bank-statements/:id/rematch`, `/:id/lines/:lineId/match { journalLineId }`, `/unmatch`, `/ignore { note }`, `/:id/complete { notes? }`               | `bank-reconciliation.perform`                   |

Statement line amounts are signed (in +, out -). A bank transaction created
with `statementLineId` matches that line when posted.

### Dimensions, tax, budgets, expense claims (all require `X-Company-Id`)

| Method                      | Path                                                                                                | Permission                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| GET / POST / PATCH          | `/dimensions?dimensionType&status`, `/dimensions/:id`                                               | `dimension.view` / `dimension.manage`         |
| GET / POST / PATCH          | `/tax/codes?side&kind&status`, `/tax/codes/:id` (rates in the body; windows must not overlap)       | `tax.view` / `tax.manage`                     |
| GET                         | `/tax/transactions` (paginated; `from`, `to`, `taxCodeId`, `side`, `sourceType`, `partyId`)         | `tax.view`                                    |
| GET                         | `/tax/reports/summary?from&to&side`, `/tax/reports/withholding?from&to&side`                        | `tax.view`                                    |
| GET / POST / PATCH / DELETE | `/budgets` (paginated; `fiscalYearId`, `status`), `/budgets/:id` (versions + periods)               | `budget.view` / `budget.manage`               |
| GET                         | `/budgets/:id/variance?versionId&toPeriodId&accountId&departmentId&costCenterId&projectId&branchId` | `budget.view`                                 |
| POST / GET / DELETE         | `/budgets/:id/versions { name, copyFromVersionId? }`, `/budgets/:id/versions/:versionId`            | `budget.manage` / `budget.view`               |
| PUT                         | `/budgets/:id/versions/:versionId/lines { lines[] }` (replaces a draft version's grid)              | `budget.manage`                               |
| POST                        | `/budgets/:id/versions/:versionId/approve`                                                          | `budget.approve`                              |
| GET / POST / PATCH / DELETE | `/expense-claims` (paginated; `status`, `claimantUserId`, `from`, `to`), `/expense-claims/:id`      | `expense-claim.view` / `expense-claim.create` |
| POST                        | `/expense-claims/:id/submit`, `/cancel { reason }`                                                  | `expense-claim.create`                        |
| POST                        | `/expense-claims/:id/approve` (not the claimant), `/reject { reason }`                              | `expense-claim.approve`                       |
| POST                        | `/expense-claims/:id/post`, `/expense-claims/:id/pay { bankAccountId, paymentDate, reference? }`    | `expense-claim.post`                          |

Journal, invoice and bill lines accept `departmentId`, `costCenterId`,
`projectId`; invoice / bill lines also `taxCodeId` and `withholdingTaxCodeId`
and return `taxRate`, `taxAmount`, `withholdingRate`, `withholdingAmount`.
Document headers carry `taxTotal` and `withholdingTotal`. Ledger reports
(`/general-ledger`, `/reports/trial-balance`, `/reports/income-statement`)
accept the three dimension filters.

### Multi-currency, consolidation, workflows, attachments (Phase 8)

| Method              | Path                                                                                                                                                                                                                                                     | Permission                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| GET / PUT / DELETE  | `/exchange-rates?fromCurrency&toCurrency&from&to`, `PUT` upserts `{ fromCurrency, toCurrency, rateDate, rate, source?, notes? }`, `/exchange-rates/:id` (organization-wide, no company header)                                                           | `exchange-rate.view` / `exchange-rate.manage`       |
| GET                 | `/exchange-rates/resolve?fromCurrency&toCurrency&onDate` (latest quote on or before the date; reverse pairs inverted)                                                                                                                                    | `exchange-rate.view`                                |
| GET / POST          | `/fx/revaluations` (paginated), `/fx/revaluations/preview?asOfDate`, `/fx/revaluations/:id`, `POST { asOfDate, reversalDate?, notes? }`                                                                                                                  | `fx.revalue` (view: `exchange-rate.view`)           |
| GET / POST / DELETE | `/intercompany` (paginated; `status`, `companyId`), `/intercompany/:id`, `POST { fromCompanyId, toCompanyId, transactionDate, amount, fromAccountId, toAccountId, description, reference?, idempotencyKey? }` (amount in the from-company base currency) | `intercompany.view` / `intercompany.post`           |
| POST                | `/intercompany/:id/post`, `/intercompany/:id/reverse { reason }` (caller must hold the permission in both companies)                                                                                                                                     | `intercompany.post`                                 |
| GET                 | `/consolidation/trial-balance?from&to&currency?&companyIds?` (`companyIds` array or comma list; defaults to every company of the organization)                                                                                                           | `consolidation.view`                                |
| GET / POST / PATCH  | `/approval-workflows`, `/approval-workflows/:id` `{ documentType, name, description?, minAmount, maxAmount?, priority, allowSelfApproval, steps[{ name, requiredPermission, minApprovers }] }` (PATCH also `status`)                                     | `approval.view` / `workflow.manage`                 |
| GET                 | `/approvals?mine&status&documentType` (paginated; `mine=true` lists only steps the caller can decide now), `/approvals/:id` (steps + decisions + `canDecide`)                                                                                            | `approval.view`                                     |
| POST                | `/approvals/:id/decide { decision: APPROVE \| REJECT, comment? }` - while a request is overdue, holders of the workflow's `escalationPermission` may decide                                                                                              | `approval.decide` + the step's `requiredPermission` |
| GET / POST          | `/attachments/:entityType/:entityId` (list; `POST` multipart `file` + optional `description`, 15 MB, PDF / images / office / csv / txt)                                                                                                                  | `attachment.view` / `attachment.manage`             |
| GET / DELETE        | `/attachments/file/:id` (download with original name), `DELETE` removes the file and the row                                                                                                                                                             | `attachment.view` / `attachment.manage`             |

Customers and vendors carry `currency` (defaults to the company base
currency); invoices, bills and payments carry `exchangeRate` (override; the
resolved rate otherwise), `baseTotal` / `baseAmount` and `controlBaseAmount`.
Allocations must be in the document's currency (`CURRENCY_MISMATCH`, 422).
Submitting a journal, expense claim or purchase order whose amount matches an
active workflow opens an approval request; approving / posting before the
request is APPROVED fails with `APPROVAL_REQUIRED` (422, `details.requestId`).

### AI assistance (Phase 9, advisory only; all require `X-Company-Id`)

| Method      | Path                                                                                                                                 | Permission                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| GET         | `/ai/status` -> `{ provider, model, advisoryOnly: true }`                                                                            | `ai.view`                                                          |
| GET / POST  | `/ai/intake` (paginated; `status`, `kind`, `search`), `POST` multipart `file` + optional `kind` (extracts, matches vendor, suggests) | `ai.view` / `ai.use`                                               |
| GET / PATCH | `/ai/intake/:id` (extracted fields, line hints, source text), `PATCH { kind?, vendorId?, extracted? }`                               | `ai.view` / `ai.review`                                            |
| POST        | `/ai/intake/:id/draft { kind: BILL \| EXPENSE_CLAIM, vendorId?, claimantUserId?, branchId? }` -> DRAFT document, file relinked       | `ai.review` + `bill.create` / `expense-claim.create`               |
| POST        | `/ai/intake/:id/dismiss { reason? }`                                                                                                 | `ai.review`                                                        |
| POST        | `/ai/classify { description, side: PURCHASE \| SALE \| EXPENSE, partyId?, amount?, limit? }` -> ranked account suggestions           | `ai.use`                                                           |
| GET         | `/ai/anomalies` (paginated; `status`, `severity`, `anomalyType`, `search`), `/ai/anomalies/summary`, `/ai/anomalies/:id`             | `ai.view`                                                          |
| POST        | `/ai/anomalies/scan { from, to }` -> flags upserted by fingerprint (`flagged`, `new`, `items`)                                       | `ai.use`                                                           |
| POST        | `/ai/anomalies/:id/decide { decision: ACCEPT \| DISMISS, note? }`                                                                    | `ai.review`                                                        |
| POST        | `/ai/ask { question, conversationId? }` -> `{ conversationId, question, answer (content, sources[]), intent }`                       | `ai.use` (+ the report's own view permission, e.g. `reports.view`) |
| GET         | `/ai/conversations` (own, paginated), `/ai/conversations/:id` (messages)                                                             | `ai.view`                                                          |
| GET         | `/ai/forecast?metric=REVENUE\|EXPENSES\|NET_INCOME\|CASH&history=12&horizon=6`                                                       | `ai.view`                                                          |

No AI route posts, approves or edits a ledger entry. Drafts come from
`BillsService` / `ExpenseClaimsService` exactly as if typed in; answers are
built from `ReportingService`, the AR / AP aging services and the ledger, and
list every figure they used. `AI_PROVIDER=HEURISTIC` (default) works offline
and is what the tests run; `ANTHROPIC` adds image reading and phrasing.

### Integrity (all require `X-Company-Id`)

| Method | Path                                                                                                                         | Permission        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| GET    | `/integrity?asOf` - runs every accounting invariant read-only -> `{ status, findings[{ check, severity, count, samples }] }` | `integrity.check` |

New error codes: `ACCOUNTING_PERIOD_SOFT_CLOSED`, `ACCOUNTING_PERIOD_LOCKED`, `SOURCE_DOCUMENT_INVALID` (all 422).

### Subledger reconciliation (all require `X-Company-Id`)

| Method      | Path                                                                                                                                                                           | Permission                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| GET         | `/reconciliations/summary?asOf` - per area: latest record, live figures, stale flag                                                                                            | `reconciliation.view`                            |
| GET / POST  | `/reconciliations` (paginated; `area`, `status`, `from`, `to`), `POST { area, asOf }` computes / recomputes                                                                    | `reconciliation.view` / `reconciliation.prepare` |
| GET         | `/reconciliations/:id` (lines, exceptions, `unexplained`)                                                                                                                      | `reconciliation.view`                            |
| POST        | `/reconciliations/:id/assign { reviewerId, notes? }`, `/notes { notes }`, `/exceptions { description, amount, reference? }`, `/exceptions/:exceptionId/resolve { resolution }` | `reconciliation.prepare`                         |
| POST        | `/reconciliations/:id/approve { notes? }` - four-eyes; open exceptions or an unexplained variance above materiality refuse (`RECONCILIATION_UNRESOLVED`)                       | `reconciliation.approve`                         |
| GET         | `/reconciliations/summary` also returns `banks[]` (ledger balance, latest statement state, unmatched / possible / exception counts)                                            | `reconciliation.view`                            |
| GET / PATCH | `/accounting-policies` `{ reconciliationMateriality?, reconciliationStaleDays? }`                                                                                              | `reconciliation.view` / `policy.manage`          |

`PATCH /accounting-policies` also accepts the close policy flags (`closeRequireReconciliations`,
`closeRequireBankReconciliation`, `closeRequireDepreciation`, `closeRequireFxRevaluation`,
`closeBlockOnUnapprovedJournals`, `closeBlockOnOpenExceptions`, `closeRequireIntegrityOk`,
`closeLockOnComplete`).

### Financial close (all require `X-Company-Id`; see `docs/financial-close.md`)

| Method     | Path                                                                                                                                                       | Permission                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| GET / POST | `/financial-closes` (paginated; `status`, `fiscalYearId`), `POST { fiscalPeriodId, closeType? }` (409 `DUPLICATE` while a live close exists)               | `close.view` / `close.manage` |
| GET        | `/financial-closes/blockers?fiscalPeriodId` - evaluate the checks without starting a close                                                                 | `close.view`                  |
| GET / POST | `/financial-closes/:id` (tasks, blockers, progress), `/:id/refresh`                                                                                        | `close.view` / `close.manage` |
| PATCH      | `/financial-closes/:id/tasks/:taskId { status?, ownerId?, reviewerId?, notes?, reason? }` (AUTO tasks refuse; `SKIPPED` on a required task needs `reason`) | `close.manage`                |
| POST       | `/financial-closes/:id/tasks { title, required?, ownerId? }`, `/:id/cancel { reason }`                                                                     | `close.manage`                |
| POST       | `/financial-closes/:id/approve { notes? }` - refuses with `CLOSE_BLOCKED` (422; `details.blockers`, `details.pendingTasks`)                                | `close.approve`               |
| POST       | `/financial-closes/:id/complete { notes? }` - closes (and per policy locks) the period in the same transaction                                             | `period.close`                |

Workflows also accept `branchId?`, `deadlineHours?` and `escalationPermission?` (H5); `VENDOR_BILL`
is a workflow document type; `GET /approvals?overdue=true` lists pending requests past their deadline
and every request carries `overdue`, `dueAt`, `escalatedAt`.

### Enterprise controls (all require `X-Company-Id`; see `docs/enterprise-controls.md`)

| Method | Path                                                                                                       | Permission      |
| ------ | ---------------------------------------------------------------------------------------------------------- | --------------- |
| GET    | `/controls/dashboard?asOf` - ten control tiles with severity and drill-down links                          | `controls.view` |
| GET    | `/accounting/suspense?asOf` - suspense / clearing accounts: balance, age, open items, owner, policy status | `journal.view`  |
| GET    | `/history?entityType&entityId[&field]` - field-level change history of one record                          | `history.view`  |

`PATCH /accounting-policies` also accepts `suspenseMateriality`, `suspenseMaxAgeDays` and
`closeBlockOnSuspense`; `PATCH /invoices/:id` and `/bills/:id` accept `changeReason`.
New audit actions: `SOD_WARNING`, `ESCALATE`.

### Audit & health

| Method | Path                                                                                                                 | Notes                         |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| GET    | `/audit-logs` (filters: `action`, `module`, `entityType`, `entityId`, `userId`, `companyId`, `from`, `to`, `search`) | `audit.view`                  |
| GET    | `/health`                                                                                                            | DB + Redis readiness (public) |
| GET    | `/health/live`                                                                                                       | Liveness (public)             |

Planned resource paths (`/fixed-assets`, `/bank-accounts`, `/budgets`, ...) follow the
same conventions.
