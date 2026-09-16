# Customer payments

`customer_payments` records receipts (`paymentType = PAYMENT`) and refunds
(`REFUND`). Fields: number, customer, date, currency, amount, method
(`CASH`, `BANK_TRANSFER`, `CHECK`, `CARD`, `DEBIT_CARD`, `ONLINE`,
`PAYMENT_GATEWAY`, `OTHER`), cash / bank GL account, reference,
`externalReference` (gateway id, cheque number), memo, exchange rate.

## Lifecycle

```text
DRAFT ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─post─▶ POSTED ─void─▶ VOID
  └────────────────────────────────────post (when no approval policy applies)
```

Derived states: `allocationStatus` (`UNALLOCATED`, `PARTIALLY_ALLOCATED`,
`ALLOCATED`) on posted receipts; "received" = POSTED; "reconciled" = the
bank statement match in the Banking module (bank balances are GL balances).

- `submit` opens a `CUSTOMER_PAYMENT` approval workflow when one matches.
- `approve` (`customer-payment.approve`) checks the workflow, then
  `AuthorityService.assert` (delegated authority, scope, limit, self-
  approval).
- `post` (`customer-payment.post`) refuses when `ar_settings.requirePaymentApproval`
  is on and the payment is not APPROVED, and when a workflow request is
  pending. It is idempotent.

## Accounting

```text
Receipt                                   Refund (mirror)
Dr Cash / bank (payment cash account)     Dr Accounts receivable
   Cr Accounts receivable (control)          Cr Cash / bank
Realized FX gain / loss lines from FxService for foreign-currency settlements
```

The bank side posts at the payment rate; the control side at each settled
document's rate, the difference being realized FX. Posting also settles the
draft allocations (`invoices.allocated_amount`, business status).

Events: `payment.created`, `payment.approved`, `payment.received`
(receipts), `payment.refunded` (refunds), `payment.completed`,
`payment.allocated`, `payment.failed` (void), `invoice.paid` for every invoice
settled in full. Notification `PAYMENT_RECEIVED` to the creator and posting
users, `APPROVAL_REQUIRED` on submit.

## Partial payments, overpayments, unapplied cash

- A receipt smaller than the invoice leaves it `PARTIALLY_PAID`.
- A receipt larger than its allocations keeps the remainder **unallocated**
  on the receipt - it is never written off. Customer `unappliedCredit` and the
  aging's unapplied column show it; `GET /unapplied-cash` lists every such
  receipt with its age and flags those older than
  `ar_settings.unappliedCashWarnDays`; the AR integrity check
  `UNALLOCATED_PAYMENT` reports them.
- `POST /customer-payments/:id/allocate` applies the remainder to open
  invoices later (no new ledger entry, realized FX if rates differ).
- `POST /customer-payments/:id/refund` turns the unapplied part into a
  refund request ([refunds.md](refunds.md)).

## API

```text
GET/POST  /api/v1/customer-payments          filters: partyId, status, paymentType, from, to, unappliedOnly, search
GET/PATCH/DELETE /api/v1/customer-payments/:id  (drafts only for PATCH / DELETE)
POST      /api/v1/customer-payments/:id/submit | approve | post | allocate | void | refund
```
