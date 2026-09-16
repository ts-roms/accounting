# Vendor payments

A vendor payment is drafted with its allocations (and, per allocation, an
optional early-payment discount), optionally submitted and approved, then
posted. Refunds received from a vendor are `REFUND` payments.

```text
DRAFT ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─post─▶ POSTED ─void─▶ VOID
  └─post (when requirePaymentApproval is off)────────▶ POSTED
```

- `approve` is delegable (`vendor-payment.approve`), workflow-gated and
  SoD-checked against the creator. `post` enforces
  `ap_settings.requirePaymentApproval` and the workflow unless the
  payment was approved upstream (payment runs).
- Posting (disbursement):

```text
Dr Accounts payable         cash + discount (+ realized FX gain)
   Cr Cash / bank           cash
   Cr Purchase discounts    discount taken
   (realized FX lines from FxService)
```

- Discounts are validated at draft and again at posting: available on the
  payment date (`discountAvailable` in `payables.logic.ts`) and, with the
  cash part, within the open balance. They become discount allocation rows
  and raise `vendor_bills.discount_taken_amount`.
- Voiding reverses the journal, releases cash and discount allocations and
  restores the bill balance.
- Events: `vendor_payment.approved`, `vendor_payment.posted`,
  `vendor_payment.voided`; notification `VENDOR_PAYMENT_APPROVAL_REQUIRED`.

```text
POST /api/v1/vendor-payments        { partyId, paymentDate, amount, cashAccountId, allocations: [{ documentId, amount, discount? }] }
POST /api/v1/vendor-payments/:id/submit | approve | post | allocate | void
```
