# Write-offs and bad debt

A receivable balance only leaves the subledger through an approved, posted
write-off request. Nothing is deleted; the invoice keeps its history and
status `WRITTEN_OFF` (or `PARTIALLY_PAID` for a partial write-off).

## Write-off requests

```text
DRAFT ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─post─▶ POSTED ─recover─▶ RECOVERED
                     └─reject─▶ REJECTED                 (draft reject = CANCELLED)
```

Reasons: `BAD_DEBT`, `SMALL_BALANCE`, `UNCOLLECTIBLE`, `OTHER`.

Requirements enforced in `WriteOffsService`:

| Requirement     | Rule                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Permission      | `write-off.create` to request, `write-off.approve` to decide (delegable), `write-off.post` to post           |
| Approval        | `WRITE_OFF` workflow when configured; `AuthorityService.assert`; requester may not approve (`SOD_VIOLATION`) |
| Reason          | reason code + free-text justification, both mandatory                                                        |
| Amount          | <= open balance, net of other pending requests; `SMALL_BALANCE` <= `ar_settings.smallBalanceThreshold`       |
| Disputes        | posting refused while the invoice has an open dispute                                                        |
| Account mapping | resolved at posting time from `ACCOUNT_MAPPINGS`, recorded on the request (`debitAccountId`)                 |
| Audit trail     | CREATE / SUBMIT / APPROVE (`WRITE_OFF_APPROVED`, delegation metadata) / POST / REVERSE                       |
| Idempotency     | `idempotencyKey` on create; post is a no-op when already posted                                              |

## Accounting

```text
Post (write-off date, base amount at the document rate)
Dr Allowance for doubtful accounts   (BAD_DEBT / UNCOLLECTIBLE when ar_settings.useAllowanceForBadDebt)
   or Bad debt expense               (BAD_DEBT / UNCOLLECTIBLE otherwise)
   or Receivable write-offs          (SMALL_BALANCE / OTHER, mapping AR_WRITE_OFF)
   Cr Accounts receivable (control)

Recovery (reversal + reinstatement)
Dr Accounts receivable (control)
   Cr Allowance (allowance policy) | Bad debt recoveries (BAD_DEBT_RECOVERY, expense policy) | Receivable write-offs
```

Posting also inserts a `payment_allocations` row with `write_off_id`, so
`invoices.allocated_amount`, aging, statements (`WRITE_OFF` lines) and the
AR/GL reconciliation (`breakdown.writeOffs`) all move together. Recovery
removes the allocation, restores the balance and lets cash be applied
normally.

## Bad-debt provisions

`bad_debt_provisions` (numbered `PRV-`) size the allowance:

- `AGING_PERCENT`: required allowance = sum over aging buckets of balance x
  rate, with rates from `ar_settings.provisionRates` (or given per run);
- `SPECIFIC`: explicit allowance per invoice, each <= its open balance.

The run snapshots the computation, reads the allowance account's balance from
the ledger (`existingAllowance`) and stores `adjustment = required -
existing`. Posting books only the adjustment:

```text
Dr Bad debt expense / Cr Allowance for doubtful accounts   (increase)
Dr Allowance / Cr Bad debt expense                          (release)
```

Reversal posts the mirror journal and marks the run `REVERSED`. No
percentage is hard-coded; a company without rates cannot run
`AGING_PERCENT`.

## API

```text
GET/POST   /api/v1/write-offs ; GET /:id ; POST /:id/submit | approve | reject | post | recover
GET/POST   /api/v1/bad-debt-provisions ; GET /:id ; POST /:id/post | reverse
```

Events: `write_off.posted`. Notification `WRITE_OFF_APPROVAL_REQUIRED` on
submit.
