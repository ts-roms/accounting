# Bank transfers and payment files

## Bank transfers (`/treasury/transfers`, numbering `BTR`)

```
DRAFT --submit--> (workflow opens, approvers notified)
DRAFT --approve--> APPROVED        bank-transfer.approve (delegable, SoD vs creator)
DRAFT | APPROVED --send--> SENT    bank-transfer.post   Dr CASH_IN_TRANSIT / Cr source bank (+ Dr BANK_CHARGES for the fee)
SENT --settle--> SETTLED           bank-transfer.post   Dr destination bank / Cr CASH_IN_TRANSIT (+ FX_GAIN / FX_LOSS)
DRAFT | APPROVED --cancel--> CANCELLED
```

- `amount` is in the source currency; `receivedAmount` in the destination
  currency (given, or derived from the rate table); `baseAmount` is what goes
  in transit. `exchangeRate` is the source rate on the transfer date.
- A transfer whose `baseAmount` exceeds `treasury_settings.transferApprovalThreshold`
  (or any transfer when the threshold is null) cannot be sent from `DRAFT`.
- Settlement may state the actual `receivedAmount` credited by the bank and a
  `settlementDate` (not before the transfer date); the difference to the
  base amount in transit is realized FX (`fxDifference`, negative = loss).
- `idempotencyKey` makes create safe to retry.
- Source identities: `BANK_TRANSFER_OUT` and `BANK_TRANSFER_IN` on the same
  transfer id, so each leg is its own posting event.
- The daily sweep flags transfers still `SENT` more than
  `unsettledTransferWarnDays` after their expected settlement
  (`BANK_TRANSFER_UNSETTLED`).

## Payment files (`/treasury/payment-files`, numbering `PMF`)

```
GENERATED --status TRANSMITTED--> TRANSMITTED --status ACKNOWLEDGED--> ACKNOWLEDGED
GENERATED --status CANCELLED--> CANCELLED
TRANSMITTED --status REJECTED--> REJECTED   (PAYMENT_FILE_REJECTED notification)
```

- `POST /treasury/payment-files { bankAccountId, format, paymentRunId | paymentIds[], valueDate?, description? }`
  selects posted `PAYMENT`-type vendor payments whose cash account is the
  bank account's GL account and which are not in another `GENERATED /
TRANSMITTED / ACKNOWLEDGED` file. Every payment must be in the account
  currency; every vendor needs an active bank account on file (except for
  positive pay, which lists cheques).
- Formats (`treasury.logic.ts`, pure and unit-tested):
  - `PESONET_CSV` - `H` header (file number, value date, currency,
    originator name / id / account / routing), `D` details (sequence,
    routing, account, beneficiary, amount, currency, remittance info, payment
    number), `T` trailer (count, total, SHA-256 of the body).
  - `ISO20022_PAIN001` - `CstmrCdtTrfInitn` with one `PmtInf` and a
    `CdtTrfTxInf` per payment.
  - `POSITIVE_PAY_CSV` - cheque register (number, date, payee, amount).
- The stored `content` is served only by `GET /treasury/payment-files/:id/download`
  (`payment-file.manage`) with `Content-Disposition`; list and detail views
  omit it and mask beneficiary account numbers to the last four digits.
- Files never touch the ledger: the payments already posted. Integrity checks
  assert file totals equal their lines, a payment sits in one live file, and
  live files carry only posted payments.
