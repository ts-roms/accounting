# Aging, statements and the dashboard

## Aging

`GET /ar-aging?asOf&partyId&customerGroupId&branchId&collectorId` (also
`/reports/ar-aging`). Open balances of posted invoices / debit notes as of
the date (allocations dated on or before `asOf` are deducted, voids after the
date are still in the ledger) age in **base currency at the document rate**,
so the total ties to the control account. Unapplied receipts and credit
notes appear in `unappliedCredit`; `net = outstanding - unappliedCredit`
equals the reconciliation's subledger balance.

### Buckets are configuration

`ar_settings.aging_buckets` (default: Current, 1-30, 31-60, 61-90, 91-120,
120+) is a contiguous list of `{ key, label, from, to }` with the last bucket
open-ended. `agingBucketFor` (pure) assigns each document. Bucket keys are
also the keys of `provisionRates` for bad-debt provisioning. Changing buckets
changes every aging response, the dashboard and future provision runs;
posted provisions keep their snapshot.

## Customer statements

`GET /customer-statements?customerId&from&to&save` returns opening balance,
movements (invoices, credit / debit notes, receipts, refunds, write-offs and
recoveries), running balance and closing balance. `save=true` stores the
issued statement (`customer_statements`, numbered `STMT-`) as a snapshot;
`GET /customer-statements/history` lists them. Snapshots are records of what
was sent - balances always come from the subledger.

## Dashboard

`GET /ar-dashboard?asOf` (executive view, `/receivables/dashboard`):

| Metric            | Definition                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Total receivables | aging `outstanding`                                                                                                |
| Current / Overdue | first bucket / the rest                                                                                            |
| DSO               | countback: open receivables / (credit sales over `dsoWindowDays` / window)                                         |
| Collection rate   | allocations from receipts in the last 30 days / invoices that fell due in the last 30 days (0-1)                   |
| Unapplied cash    | unallocated posted receipts; stale = older than `unappliedCashWarnDays`                                            |
| Credit exposure   | sum of credit used across active customers, total limits, customers over limit / on hold                           |
| Collections       | open cases, open disputes, pending / broken promises                                                               |
| Charts            | aging buckets; collections trend (receipts vs invoiced per month); revenue vs month-end receivables; DSO per month |
| Top overdue       | largest overdue balances from the aging rows                                                                       |

All figures are computed from posted documents at request time.
