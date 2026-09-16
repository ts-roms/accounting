# Refunds

Customer credit (overpayments, unapplied receipts, open credit notes) is
returned through a **refund request** (`payment_refunds`), not by posting a
refund directly.

```text
Customer credit ─▶ DRAFT ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─pay─▶ PAID
                                        └─reject─▶ REJECTED     any ─cancel─▶ CANCELLED
```

## Controls

- **Cap.** At create and at approve, `amount + other SUBMITTED / APPROVED
requests` may not exceed the customer's unapplied credit
  (`ALLOCATION_EXCEEDS_BALANCE`). Posting the refund receipt re-checks the
  credit inside `CustomerPaymentsService.postInTx`.
- **Approval.** `customer-refund.approve` (delegable), workflow
  `CUSTOMER_REFUND` when configured, `AuthorityService.assert` for delegated
  grants, and a hard rule: the requester may not approve (`SOD_VIOLATION`).
- **Payment.** `customer-refund.pay` runs `pay`: inside one transaction a
  `REFUND` customer payment is drafted (`createInTx`), marked as approved
  upstream and posted (`postInTx`, `approvedUpstream: true`):

```text
Dr Accounts receivable (control)
   Cr Cash / bank (request cash account)
```

The refund receipt is linked (`refundPaymentId`) and the customer's
unapplied credit drops accordingly; the AR/GL reconciliation includes it
under `refunds`.

## API

```text
GET/POST  /api/v1/refunds                     (customer-refund.create)
POST      /api/v1/refunds/:id/submit | approve | reject | cancel | pay
POST      /api/v1/customer-payments/:id/refund   shortcut: request for the receipt's unapplied amount
```

Events: `refund.approved`, `payment.refunded` (when paid). Notification
`REFUND_APPROVAL_REQUIRED` to approvers on submit. Audit: CREATE / SUBMIT /
APPROVE (with delegation metadata) / REJECT / POST / VOID on
`RefundRequest`.
