# AP reconciliation and integrity

`GET /reports/ap-reconciliation?asOf` proves the AP subledger equals the
`ACCOUNTS_PAYABLE` control account:

```text
subledger = bills + debit notes − credit notes − payments (control amount) + refunds + FX adjustments
```

The payment control amount already contains the discount taken and the
realized FX, so discounts are reported in the breakdown for transparency
but not added again. `SubledgerBalancesService` reuses this computation
for the Reconciliation Center.

`GET /ap-integrity?asOf` (`integrity.check`) runs 19 read-only checks:
journals behind posted bills / payments / accruals, near-duplicate bills and
payments, unapplied payments, held bills settled, hold-flag drift, draft
bills for blocked vendors or in closed periods, account mappings, control
account usage, AP/GL mismatch, GRNI mismatch, bills without lines,
allocation drift, discount drift, run lines vs payments, over-allocated
bills.
