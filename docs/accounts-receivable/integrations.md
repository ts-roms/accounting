# AR integrations, webhooks and notifications

## Inbound (integration platform)

Importers are the only bridge from an external record to the domain; they
validate with the API's Zod schemas and call the same services the REST API
uses (see [../integrations/architecture.md](../integrations/architecture.md)).

| Entity         | Importer              | Domain call                                                 | Posting                                                         |
| -------------- | --------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| `customers`    | `CustomersImporter`   | `CustomersService.create / update`                          | n/a                                                             |
| `sales-orders` | `SalesOrdersImporter` | `OrdersService.create` (DRAFT) + `submit` when `autoSubmit` | never - approval, delivery and invoicing follow the normal flow |
| `invoices`     | `InvoicesImporter`    | `InvoicesService.create` (DRAFT)                            | only with `invoices:post` scope **and** `autoPost`              |
| `payments`     | `PaymentsImporter`    | `CustomerPaymentsService.create` (DRAFT)                    | only with `payments:post` scope                                 |

API scopes added: `sales-orders:read`, `sales-orders:write`,
`deliveries:read`, `collections:read`. A key or integration can never do more
than its owner; no scope grants approval of write-offs, refunds or credit
holds.

Typical sources map as: e-commerce / POS / CRM -> `sales-orders`, payment
gateway / bank -> `payments` (with `externalReference`), external ERP ->
`customers` + `invoices`.

## Outbound webhooks

Events are written with `OutboxService.enqueue` inside the business
transaction and delivered by the outbound webhook worker:

```text
customer.created  customer.updated  customer.credit_hold  customer.credit_released  customer.over_credit_limit
sales_order.created  sales_order.submitted  sales_order.approved  sales_order.confirmed  sales_order.cancelled
delivery.created  delivery.delivered
invoice.created  invoice.approved  invoice.posted  invoice.paid  invoice.overdue  invoice.voided  invoice.cancelled  invoice.disputed
credit_note.posted  debit_note.posted
payment.created  payment.approved  payment.received  payment.completed  payment.allocated  payment.refunded  payment.failed
refund.approved  write_off.posted  collection.case_opened  collection.promise_broken
```

Payloads carry identifiers, amounts and statuses only - never line-level or
contact PII.

## Notifications

In-app notifications (`NotificationsService`, per-organization policies with
throttling) for: `APPROVAL_REQUIRED` (invoice / payment submit),
`INVOICE_APPROVED`, `INVOICE_POSTED`, `INVOICE_OVERDUE`, `PAYMENT_RECEIVED`,
`PAYMENT_FAILED`, `CUSTOMER_OVER_CREDIT_LIMIT`, `CUSTOMER_CREDIT_HOLD`,
`COLLECTION_ACTION_REQUIRED`, `PROMISE_BROKEN`, `DISPUTE_OPENED`,
`WRITE_OFF_APPROVAL_REQUIRED`, `REFUND_APPROVAL_REQUIRED`,
`AR_RECONCILIATION_DIFFERENCE`. Dedupe keys (per document / customer / step)
and the policy throttle window keep the daily sweep from paging anyone twice
for the same thing.

## Delegated authority

`customer-payment.approve`, `customer-refund.approve` and
`write-off.approve` join `sales-order.approve` and `invoice.approve` in
`DELEGABLE_PERMISSIONS`. Delegated approvals are verified per document by
`AuthorityService.assert` (company / branch scope, amount ceiling, delegator
still authorised, self-approval refused) and recorded; the UI shows the
"Acting under delegated authority" notice with delegator, validity and limit.
Delegation never grants posting, configuration or credit-hold rights.
