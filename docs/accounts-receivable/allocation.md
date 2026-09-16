# Allocation

Allocations settle open invoices and debit notes. They never create journal
entries: the receivable was posted when the invoice posted, the cash when the
receipt posted; an allocation only records which document the cash (or credit
note, or write-off) settled, so the subledger can age and report per document.

## Sources

`payment_allocations` rows carry exactly one source
(`payment_allocations_source_chk`):

| Source           | Created by                                         | Amount cap                      |
| ---------------- | -------------------------------------------------- | ------------------------------- |
| `payment_id`     | receipt posting (draft allocations) or `/allocate` | receipt's unallocated remainder |
| `credit_note_id` | `POST /invoices/:id/apply` on a posted credit note | credit note's open balance      |
| `write_off_id`   | `POST /write-offs/:id/post`                        | approved write-off amount       |

Targets must be posted, open (`APPROVED` / `PARTIALLY_PAID`), of the same
customer and currency; a document may appear once per allocation set; the sum
may not exceed the available amount (`validateAllocations` in
`subledger.logic.ts`). `invoices.allocated_amount` is maintained in the same
transaction and the business status derived
(`deriveDocumentStatus`: APPROVED / PARTIALLY_PAID / PAID; a final write-off
allocation sets `WRITTEN_OFF`).

## Example

```text
Receipt RCP-000123                 100,000.00
  INV-000101  60,000.00   -> PAID
  INV-000102  30,000.00   -> PAID
  INV-000103  10,000.00   -> PARTIALLY_PAID (balance 15,000.00)
Allocated 100,000.00  Unallocated 0.00
```

```text
Invoice INV-000104  100,000.00
  Payment 1          40,000.00   -> PARTIALLY_PAID
  Payment 2          30,000.00   -> PARTIALLY_PAID, balance 30,000.00
```

## Foreign currency

Allocations are in document currency. When the settling receipt's rate
differs from the invoice's document rate, `FxService.settlementGain` computes
the realized difference and posts it (`AR_PAYMENT_ALLOCATION` /
`AR_CREDIT_APPLICATION` events) - the only ledger effect an allocation can
trigger, and it is posted by the posting gateway, not by the allocation.

## Releasing

Voiding a receipt (`releaseFromTargets`) or recovering a write-off deletes /
reverses the allocations and recomputes the targets' status; voiding a
document with allocations is refused (`DOCUMENT_HAS_ALLOCATIONS`).

## Integrity

`ALLOCATION_DRIFT` (AR integrity) asserts
`invoices.allocated_amount = SUM(payment_allocations.amount)` and
`customer_payments.allocated_amount = SUM(... where payment_id)` for every
row.
