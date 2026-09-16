# Sales orders and deliveries

Sales orders live in the shared `orders` table (`orderType = SALES_ORDER`)
and never post to the ledger. Prompt #6 adds the credit-checked lifecycle,
header fields carried to the invoice and deliveries.

## Lifecycle

```text
DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED ──confirm──▶ CONFIRMED ──(fully invoiced)──▶ CLOSED
  │  (credit check,          (workflow +      (open for delivery / invoicing)
  │   opens workflow)          delegated authority,
  └──approve (direct)──────────credit check again)
SUBMITTED ──reject──▶ REJECTED ──submit──▶ ...
any open status ──cancel──▶ CANCELLED (refused once delivered / invoiced; close instead)
```

- `submit` runs `CreditService.check('SALES_ORDER')` and opens an approval
  request when a `SALES_ORDER` workflow matches the amount.
- `approve` re-runs the credit check, calls
  `ApprovalsService.assertApproved`, `AuthorityService.assert(sales-order.approve)`
  (delegation scope / limit / self-approval) and records SoD warnings.
  A `REQUIRE_APPROVAL` finding can only be cleared by a holder of
  `sales-order.approve`.
- `confirm` marks customer confirmation (`confirmedBy / At`); `APPROVED` and
  `CONFIRMED` are both open for fulfilment (`OPEN_ORDER_STATUSES`).
- Fulfilment counters (`billedQuantity`, `deliveredQuantity`) change only
  through `OrderFulfillmentService` inside the invoice / delivery transaction;
  the order auto-closes when fully invoiced.

Header fields added: `paymentTermId`, `salespersonId` (defaulted from the
customer), `warehouseId`, `creditCheck` snapshot, `deliveryStatus`.

API: `/api/v1/sales-orders` (+ `/:id/submit`, `/approve`, `/reject`,
`/confirm`, `/close`, `/cancel`, `/fulfil`). Events: `sales_order.created`,
`.submitted`, `.approved`, `.confirmed`, `.cancelled`.

## Deliveries

`deliveries` / `delivery_lines` record goods leaving against an open sales
order.

```text
DRAFT ──pick──▶ PICKING ──ready──▶ READY ──deliver──▶ DELIVERED ──invoice──▶ (draft invoice)
any ──cancel──▶ CANCELLED   (a delivered one reverses stock + COGS; refused once invoiced)
```

`deliver` consumes the order's `DELIVERY` counter, issues stocked lines
through `DocumentStockService.postSalesLines` (source `DELIVERY`) and posts
the cost of goods (`Dr COGS / Cr Inventory`) with `permission:
delivery.manage`. Service lines produce no journal. `POST
/deliveries/:id/invoice` raises a draft invoice for the delivered, not yet
invoiced quantities at the order prices with `deliveryId` set; when that
invoice posts it **does not move stock again** (the delivery already did) and
copies the delivery cost onto its lines for margin reporting.

API: `/api/v1/deliveries` (+ `/:id/pick`, `/ready`, `/deliver`, `/cancel`,
`/invoice`). Events: `delivery.created`, `delivery.delivered`.

## Integration

`SalesOrdersImporter` (integration platform) maps an external order to
`OrdersService.create` as a DRAFT and, with `autoSubmit`, submits it - the
credit check and approvals still apply and nothing posts. See
[integrations.md](integrations.md).
