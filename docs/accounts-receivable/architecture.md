# Accounts receivable & order-to-cash - architecture

The AR platform (Prompt #6) extends the Phase 3 subledger into a full
order-to-cash and collections module. It is one NestJS module
(`apps/api/src/modules/receivables`) plus the shared `orders` module for sales
orders, one web section (`/receivables/*` and the existing `/sales/*` screens)
and one migration (`0016_receivables_platform`). Every ledger effect still goes
through `AccountingPostingService`; the module owns business state and
subledger balances, never GL rows.

## Flow

```text
Customer master ─▶ Sales order ─▶ Delivery ─▶ Invoice ─▶ Receipt ─▶ Allocation ─▶ Bank / reconciliation
   credit profile   credit check   COGS post   AR post    cash post   (no ledger)      Reconciliation Center
   groups, terms    workflow       stock issue tax, dims  approval    FX gain/loss
                    delegation                 workflow   workflow
                                                          refund ─▶ REFUND receipt (Dr AR / Cr cash)
Collections: cases, activities, promises, dunning, disputes, credit hold
Write-offs: request ─▶ approval ─▶ post (Dr allowance/expense, Cr AR) ─▶ recovery
Bad debt: provision runs bring the allowance to the required level
```

## Module map

| Service                   | Responsibility                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ArConfigService`         | payment terms, customer groups, credit rules, dunning policies, `ar_settings` (aging buckets, flags)  |
| `CustomersService`        | customer master, contacts, addresses, derived balances                                                |
| `CreditService`           | credit position / summary, rule evaluation, credit holds, over-limit notifications                    |
| `OrdersService` (orders)  | sales-order lifecycle incl. submit / confirm, credit check, approval workflow                         |
| `DeliveriesService`       | deliveries: stock issue through `InventoryService`, COGS journal, invoice-from-delivery               |
| `InvoicesService`         | invoices / credit / debit notes: submit, approve, post, void, apply credit notes                      |
| `CustomerPaymentsService` | receipts / refunds: submit, approve, post, allocate, void                                             |
| `RefundsService`          | refund requests: capped by credit, approval, pay (creates + posts a REFUND receipt)                   |
| `CollectionsService`      | cases, activities, promises, credit hold from the workspace, daily sweep (overdue, dunning, promises) |
| `DisputesService`         | invoice disputes and their effect on dunning / write-off                                              |
| `WriteOffsService`        | write-off requests, posting, recovery; bad-debt provision runs                                        |
| `ArReportsService`        | aging (configurable buckets), statements (with write-offs), AR/GL reconciliation                      |
| `ArDashboardService`      | executive KPIs and trends, unapplied cash monitor, statement snapshots                                |
| `ArIntegrityService`      | AR integrity checks (spec section 41)                                                                 |
| `ReceivablesSweepJob`     | daily BullMQ job calling `CollectionsService.runSweep` per company                                    |
| `SalesOrdersImporter`     | integration platform: external order -> draft sales order (never posts)                               |

Pure logic lives in `receivables.logic.ts` (due dates, credit rules, aging,
DSO, promise evaluation, dunning step selection, provisioning) and is unit
tested without a database.

## Accounting principles

- **One source of truth.** Balances (customer, aging, dashboard) are derived
  from posted `invoices` / `customer_payments` rows and their allocations.
  Nothing stores a running balance.
- **Posting gateway only.** Invoices, receipts, refunds, deliveries (COGS),
  write-offs, recoveries and provisions all call
  `AccountingPostingService.postEvent` with the module permission
  (`invoice.post`, `customer-payment.post`, `delivery.manage`,
  `write-off.post`). Accounts come from `AccountsService.resolveMapped`
  (`ACCOUNTS_RECEIVABLE`, `BAD_DEBT_EXPENSE`,
  `ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS`, `AR_WRITE_OFF`, `BAD_DEBT_RECOVERY`) and
  from document lines - never ids in code.
- **Source identity.** Every posting event has its own `sourceType` /
  `sourceId` (`AR_DOCUMENT`, `AR_PAYMENT`, `DELIVERY`, `DELIVERY_CANCEL`,
  `AR_WRITE_OFF`, `AR_WRITE_OFF_RECOVERY`, `AR_PROVISION`,
  `AR_PROVISION_REVERSAL`), validated by the gateway.
- **Reversal, never edit.** Voids, delivery cancellations, write-off
  recoveries and provision reversals post mirror journals and mark the
  original `REVERSED`.
- **Subledger = GL.** `ArReportsService.reconciliation` builds the subledger
  from posted invoices + debit notes - credit notes - receipts + refunds + FX -
  write-offs (net of recoveries) and compares it with the control account.
  `SubledgerBalancesService`, the integrity checker, the financial close and
  the AR reconciliation screen all use it.

## Controls in one place

| Control                    | Where                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Permissions                | `@RequirePermissions` on every route; new keys in `packages/types/src/permissions.ts`                                     |
| Delegated authority        | `AuthorityService.assert` on sales-order, invoice, payment, refund and write-off approvals                                |
| Approval workflows         | `ApprovalsService.open / assertApproved` for `SALES_ORDER`, `INVOICE`, `CUSTOMER_PAYMENT`, `CUSTOMER_REFUND`, `WRITE_OFF` |
| Segregation of duties      | orders: `SodService` warnings; refunds / write-offs: requester may not approve (hard rule)                                |
| Credit policy              | `CreditService.check` at sales-order and invoice submit / approve; holds always block                                     |
| Company / branch isolation | every query is company-scoped; branches validated by the posting gateway                                                  |
| Periods                    | `resolvePeriod` at draft time and inside `postEvent`                                                                      |
| Idempotency                | `idempotencyKey` on orders, deliveries, invoices, payments, refunds, write-offs; posting is a no-op when already posted   |
| Audit                      | `AuditService.record` inside every transaction, with `kind` metadata for credit / collection events                       |
| Events                     | `OutboxService.enqueue` inside the transaction (see [integrations.md](integrations.md))                                   |

## Database

New tables: `payment_terms`, `customer_groups`, `customer_contacts`,
`customer_addresses`, `customer_credit_profiles`, `credit_rules`,
`dunning_policies`, `ar_settings`, `deliveries`, `delivery_lines`,
`payment_refunds`, `collection_cases`, `collection_activities`,
`promises_to_pay`, `invoice_disputes`, `write_off_requests`,
`bad_debt_provisions`, `customer_statements`. Extended: `customers`
(type, group, term, salesperson, industry, region, branch, tax flags),
`orders` / `order_lines` (delivery counters, term, salesperson, credit check
snapshot, confirmation), `invoices` (delivery, term, submitted, written-off
amount), `customer_payments` (external reference, submitted / approved),
`payment_allocations` (`write_off_id` as a third settlement source).

AR reconciliation records reuse the existing `reconciliations` table
(`area = AR`); no parallel ledger tables were created.
