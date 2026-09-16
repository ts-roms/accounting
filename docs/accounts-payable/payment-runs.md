# Payment runs

A payment run turns the open AP into a reviewed batch of payments.

```text
DRAFT (proposal) ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─execute─▶ EXECUTING ─▶ COMPLETED / PARTIALLY_COMPLETED
  └─approve (direct)─▶ APPROVED                             any open ─cancel─▶ CANCELLED
```

## Proposal (`proposePaymentRun`, pure)

Candidates are open, posted bills in the run currency for the selected
vendors / group / branch. Rules, in order:

1. bills on payment hold or from held / blocked vendors are excluded;
2. `DUE` takes bills due on or before the pay-through date;
   `DUE_OR_DISCOUNT` also takes bills whose discount is still available on
   the payment date; `MANUAL` takes the listed bills;
3. bills are ordered oldest due first and the optional `maximumAmount`
   caps the cash total (`OVER_MAXIMUM`);
4. a vendor whose selected total stays under its
   `minimumPaymentAmount` is dropped (`BELOW_MINIMUM`).

Every decision is stored as a run line (`SELECTED` / `EXCLUDED` + reason)
so the reviewer sees what was left out and why. While the run is a draft,
lines can be excluded, re-included (never held ones), paid partially, or
have the discount dropped.

## Approval and execution

- `submit` opens the `PAYMENT_RUN` workflow; `approve` (delegable
  `payment-run.approve`) is SoD-checked against the proposer and re-checks
  holds, dropping any bill held since the proposal.
- `execute` (`payment-run.execute`, SoD against the approver) creates one
  vendor payment per vendor with the run's cash account, date and method
  (vendor profile method wins), allocations and discounts, marks it approved
  upstream and posts it - each vendor in its own transaction. Failures land
  on the lines (`FAILED` + reason) and the run ends
  `PARTIALLY_COMPLETED`; re-executing a completed run is rejected.
- `ap_settings.requireRunApproval` (default on) forbids executing an
  unapproved run.

## Remittance

`GET /payment-runs/:id/remittance?format=CSV|REMITTANCE_ADVICE` produces
the bank / remittance file for an executed run, one row per payment, with
the vendor's primary bank account in full (`payment-run.execute` only).

## API

```text
GET/POST /api/v1/payment-runs
PATCH    /api/v1/payment-runs/:id/lines      { lines: [{ billId, amount?, takeDiscount?, excluded? }] }
POST     /api/v1/payment-runs/:id/submit | approve | execute | cancel
GET      /api/v1/payment-runs/:id/remittance
GET      /api/v1/cash-requirements?asOf&days&vendorId
```
