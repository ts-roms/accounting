# Received not billed and AP accruals

## GRNI analysis (`GET /grni`)

For every approved purchase order, `receivedQuantity − billedQuantity` per
line valued at the PO price, with the age since the last confirmed receipt:

- **stocked** lines (product) were posted `Dr inventory / Cr GRNI` at
  receipt; their total is reconciled to the `GOODS_RECEIVED_NOT_INVOICED`
  account (`grniAccountBalance`, `difference`; integrity `GRNI_MISMATCH`);
- **service / expense** lines carry no accounting yet - they are what the
  period-end accrual books.

Lines older than `ap_settings.grniAgeWarnDays` are flagged (`GRNI_AGED`
notification from the daily sweep).

## Accrual runs (`ap_accruals`)

```text
DRAFT ─post─▶ POSTED (accrual journal + reversal journal in one transaction) ; DRAFT ─delete
```

- `RECEIVED_NOT_BILLED`: lines are computed from the unstocked GRNI rows on
  the accrual date; `MANUAL`: lines are given (contracts without a PO).
- Posting: `Dr expense (line accounts, dimensions) / Cr ACCRUED_EXPENSE` on
  the accrual date, the mirror image on the reversal date
  (`journalType REVERSAL`, `reversalOfId`), the accrual marked `REVERSED`.
  Both go through the posting gateway with `ap-accrual.post`.
- Accruals never touch the AP control, so AP stays reconciled.

```text
GET/POST /api/v1/ap-accruals      { accrualDate, reversalDate, source, lines? }
POST     /api/v1/ap-accruals/:id/post ; DELETE /api/v1/ap-accruals/:id
GET      /api/v1/grni?asOf&vendorId&minAgeDays
```
