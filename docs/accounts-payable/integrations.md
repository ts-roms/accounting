# Integrations, events and notifications

## Importer

`purchase-orders` (`PurchaseOrdersImporter`): an external purchase order
becomes a DRAFT purchase order for a known vendor (by external reference or
code); `config.autoSubmit` submits it (vendor gate + workflow) but never
approves. Requires the `purchase-order.create` scope
(`purchase-orders:write`). The existing `vendors` and `bills` importers
are unchanged.

## Outbound events (outbox, inside the business transaction)

`purchase_order.submitted / approved / rejected`, `goods_receipt.confirmed`,
`bill.created / submitted / approved / posted / on_hold / released / voided
/ due_soon`, `vendor_credit.posted`, `vendor_payment.approved / posted /
voided`, `payment_run.submitted / approved / executed`,
`vendor.created / updated / approved / on_hold / released`,
`ap_accrual.posted`.

## Notifications

`VENDOR_APPROVAL_REQUIRED`, `VENDOR_ON_HOLD`, `BILL_APPROVAL_REQUIRED`,
`BILL_APPROVED`, `BILL_ON_HOLD`, `BILL_DUE_SOON`, `DISCOUNT_EXPIRING`,
`VENDOR_PAYMENT_APPROVAL_REQUIRED`, `PAYMENT_RUN_APPROVAL_REQUIRED`,
`PAYMENT_RUN_EXECUTED`, `GRNI_AGED`. `AP_RECONCILIATION_DIFFERENCE` is
reserved (the difference is surfaced on the reconciliation screen and the
integrity report).

## Daily sweep

`PayablesSweepJob` (`QUEUES.MAINTENANCE`, every 24 h, or
`POST /payables/sweep?asOf`): raises `bill.due_soon` per bill falling due
within `dueSoonDays`, one `BILL_DUE_SOON` digest, one
`DISCOUNT_EXPIRING` digest for discounts lapsing within
`discountWarnDays`, and `GRNI_AGED` for receipt lines older than
`grniAgeWarnDays`. Idempotent; nothing is posted or paid.

## API scopes

`purchase-orders:read`, `purchase-orders:write`, `payment-runs:read`.
