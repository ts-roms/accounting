# Payment holds

A payment hold keeps a posted bill out of settlement without touching the
ledger: the liability stays on the books and keeps aging.

```text
bill (posted, open) ─hold─▶ bill_holds ACTIVE ─release─▶ RELEASED
                            vendor_bills.on_hold = true          on_hold = false
```

- Reasons: `PRICE_DISCREPANCY`, `QUANTITY_DISCREPANCY`, `QUALITY_ISSUE`,
  `MISSING_RECEIPT`, `DUPLICATE_SUSPECTED`, `VENDOR_DISPUTE`,
  `DOCUMENTATION`, `OTHER`. One active hold per bill.
- Effects: `BillsService.lockTargets` marks the target on hold, so manual
  payments and credit applications are refused
  (`MATCH_EXCEPTION_UNREVIEWED`, the same path as an unreviewed three-way
  match); payment-run proposals exclude it (`ON_HOLD`) and approval drops
  it if the hold was placed after the proposal; cash requirements report it
  separately.
- Voiding a bill releases its holds. Releasing needs `bill.hold` and is
  audited with the note.
- Integrity: `HELD_BILL_SETTLED` (a settlement dated after an active hold)
  and `BILL_HOLD_FLAG_DRIFT` (mirror column vs active rows).
- Events / notifications: `bill.on_hold`, `bill.released`, `BILL_ON_HOLD`.

```text
POST /api/v1/bills/:id/hold             { reason, note }     (bill.hold)
GET  /api/v1/bill-holds?status=ACTIVE
POST /api/v1/bill-holds/:id/release     { note }             (bill.hold)
```
