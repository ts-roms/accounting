# Bills, vendor credits and payment terms

A bill is created against a usable vendor. Its due date and early-payment
window come from the named payment term (bill → vendor → none), falling
back to the vendor's net days:

```text
term 2/10 net 30, bill dated 2026-03-01, total 11,200
  dueDate       2026-03-31
  discountDate  2026-03-11
  discountAmount   224.00   (2 % of the total, settleable until the discount date)
```

## Lifecycle

```text
DRAFT ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─post─▶ (accounting POSTED) ─pay─▶ PARTIALLY_PAID / PAID
  └─approve (direct)─▶ APPROVED                                            any unsettled ─void─▶ VOID
```

- `submit` opens the `VENDOR_BILL` workflow and notifies approvers
  (`BILL_APPROVAL_REQUIRED`). `approve` is delegable, workflow-gated and
  SoD-checked (creator ≠ approver, even with a delegated grant). `post`
  needs `bill.post`; posting is `Dr expense / inventory / GRNI lines, Cr
accounts payable` (credit notes mirror it).
- Duplicate supplier invoice numbers are rejected by the unique index;
  near-duplicates (same vendor, amount, date) warn, or block when
  `ap_settings.blockDuplicateVendorInvoice` is on.
- `requirePoForStockBills` forces a purchase order on bills with product
  lines.
- Events: `bill.created`, `bill.submitted`, `bill.approved`,
  `bill.posted` / `vendor_credit.posted`, `bill.voided`, `bill.due_soon`.

## Vendor credits and debit notes

`POST /vendor-credits` and `POST /vendor-debit-notes` create
`CREDIT_NOTE` / `DEBIT_NOTE` bills. A posted credit is applied to open
bills with `POST /bills/:id/apply` (no journal - allocation only).

## Payment holds

See `holds.md`.

## API

```text
GET/POST/PATCH/DELETE /api/v1/bills             filters: openOnly, overdueOnly, onHold, purchaseOrderId, vendorGroupId, discountAvailableOnly (+asOf)
POST /api/v1/bills/:id/submit | approve | post | void | apply | match-review | hold
GET/POST /api/v1/vendor-credits | vendor-debit-notes
```
