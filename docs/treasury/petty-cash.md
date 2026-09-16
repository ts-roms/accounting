# Petty cash

Imprest system: a fund holds a fixed float; disbursements are vouchers; the
float is restored by reimbursing the spent vouchers from the bank.

## Funds (`/treasury/petty-cash/funds`, `treasury-settings.manage` to configure)

| Field                  | Meaning                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `glAccountId`          | A dedicated, postable asset account (one fund per account).                                                 |
| `imprestAmount`        | The float.                                                                                                  |
| `custodianId`          | Who holds the box; gets the `PETTY_CASH_LOW` nudge.                                                         |
| `voucherApprovalLimit` | Above this the approver must not be the preparer (falls back to `treasury_settings.pettyCashVoucherLimit`). |
| `replenishAtPercent`   | Replenishment is due when expected cash on hand <= this share of the imprest.                               |
| `status`               | `ACTIVE / SUSPENDED / CLOSED` - only active funds take vouchers.                                            |

Derived on every read (never stored): `bookBalance` (fund GL), `unreplenished`
(posted vouchers not yet reimbursed), `expectedCashOnHand = imprest -
unreplenished`, `replenishmentDue`, `draftCount`.

## Vouchers (`/treasury/petty-cash/vouchers`, numbering `PCV`)

```
DRAFT --approve--> APPROVED --post--> POSTED --void--> VOID (reversal journal)
DRAFT | APPROVED --void--> VOID (no ledger effect)
```

- Create / update (`petty-cash.manage`): fund, date (draft-time period check),
  payee, receipt reference, lines (`description`, `accountId`, `amount`,
  optional tax code and dimensions validated by `DimensionsService`). A
  voucher may not exceed the fund's expected cash on hand
  (`ALLOCATION_EXCEEDS_BALANCE`).
- Approve (`petty-cash.approve`, delegable): `AuthorityService.assert` with
  the fund's branch and the voucher amount; above the limit
  `SodService.checkActorSeparation(petty-cash.manage, petty-cash.approve)`.
- Post (`petty-cash.post`): `Dr` each line account / `Cr` fund account,
  source `PETTY_CASH_VOUCHER`; emits `petty_cash.voucher_posted`; notifies the
  custodian when the fund crosses its replenishment line.
- Void (`petty-cash.post`, `{ reason, voidDate? }`): a posted voucher gets a
  `REVERSAL` journal (`PETTY_CASH_VOUCHER_VOID`, dated `voidDate` or today);
  a reimbursed voucher can no longer be voided - record a receipt instead.

## Replenishment (`POST /treasury/petty-cash/funds/:id/replenish`, `petty-cash.post`)

`{ bankAccountId, replenishmentDate, amount?, reference? }` creates and posts
a `WITHDRAWAL` bank transaction through `BankingService` (`Dr` fund / `Cr`
bank) for the unreimbursed total (or the amount given, e.g. to establish a
new fund), then stamps `replenishmentId` on the posted vouchers dated on or
before the replenishment date and `lastReplenishedAt` on the fund. Emits
`petty_cash.replenished`.

## Invariants (treasury integrity)

- `PETTY_CASH_OVERSPENT`: unreimbursed vouchers never exceed the imprest.
- `VOUCHERS_WITHOUT_JOURNAL`: every posted voucher has its journal.
- `PETTY_CASH_LEDGER_DRIFT`: fund GL = imprest - unreimbursed vouchers as of
  the date (a warning until a new fund is funded; anything else touching the
  fund account shows up here).
