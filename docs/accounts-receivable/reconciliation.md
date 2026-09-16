# AR reconciliation and integrity

## The invariant

```text
AR subledger  =  posted invoices + debit notes − credit notes − receipts + refunds + FX adjustments − write-offs (net of recoveries)
              =  balance of the mapped ACCOUNTS_RECEIVABLE control account
```

`ArReportsService.reconciliation(company, { asOf })` computes both sides in
base currency (documents at their document rate, receipts at their control
base amount, write-offs at `baseAmount` while `writeOffDate <= asOf` and not
recovered by then). `GET /ar-reconciliation?asOf` returns the comparison,
the breakdown and the AR integrity report; `GET /reports/ar-reconciliation`
returns the comparison alone (used by e2e suites and the AP twin).

The same computation feeds:

- `SubledgerBalancesService.compute('AR')` and therefore the Reconciliation
  Center records (`reconciliations`, area `AR`), materiality, exceptions and
  four-eyes approval ([../reconciliation.md](../reconciliation.md));
- the accounting integrity checker (`AR_CONTROL_VARIANCE`) and the financial
  close checklist.

A difference is shown as **Reconciliation difference** on
`/receivables/reconciliation`; the seeded `AR_RECONCILIATION_DIFFERENCE`
notification type is reserved for the close / reconciliation record flow.

## AR integrity checks

`ArIntegrityService.run` (`GET /ar-integrity?asOf`, embedded in
`/ar-reconciliation`):

| Check                       | Severity | Assertion                                                                |
| --------------------------- | -------- | ------------------------------------------------------------------------ |
| `INVOICE_WITHOUT_JOURNAL`   | critical | every posted invoice / note has a posted journal                         |
| `PAYMENT_WITHOUT_JOURNAL`   | critical | every posted receipt / refund has a posted journal                       |
| `WRITE_OFF_WITHOUT_JOURNAL` | critical | every posted write-off has a journal                                     |
| `DUPLICATE_INVOICE`         | warning  | no customer invoiced twice for the same reference, date and amount       |
| `DUPLICATE_PAYMENT`         | warning  | no receipt recorded twice (amount, date, reference)                      |
| `UNALLOCATED_PAYMENT`       | warning  | no receipt unapplied longer than `unappliedCashWarnDays`                 |
| `INVALID_CUSTOMER`          | warning  | open documents belong to active customers of the company                 |
| `CLOSED_PERIOD_POSTING`     | critical | no AR journal posted after its period was closed                         |
| `AR_ACCOUNT_MAPPING`        | critical | AR mappings resolve to postable accounts of the right type               |
| `AR_CONTROL_USAGE`          | critical | every AR document / payment / write-off journal hits the control account |
| `AR_GL_MISMATCH`            | critical | subledger equals the control account                                     |
| `ORPHANED_INVOICE_LINES`    | critical | every invoice has lines (FK guarantees every line has an invoice)        |
| `ALLOCATION_DRIFT`          | critical | allocated amounts equal the sum of allocation rows                       |
| `NEGATIVE_BALANCE`          | warning  | customers with a net credit balance are reviewed                         |

Every check is read-only and returns up to 20 samples for drill-down.
