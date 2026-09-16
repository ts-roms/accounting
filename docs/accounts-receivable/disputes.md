# Disputes

`invoice_disputes` (numbered `DSP-`) record a customer challenge on a posted
invoice or debit note: reason (`INCORRECT_QUANTITY`, `INCORRECT_PRICE`,
`DUPLICATE_INVOICE`, `TAX_ISSUE`, `MISSING_DELIVERY`, `CUSTOMER_REJECTION`,
`OTHER`), disputed amount (default: the open balance), description, who
raised it, assignee.

```text
OPEN ─▶ INVESTIGATING ─▶ RESOLVED ─▶ CLOSED
  └───────────────────▶ RESOLVED / CLOSED (a resolution code is required)
```

Resolutions: `UPHELD`, `CREDIT_NOTE`, `PARTIAL_CREDIT`, `REJECTED`,
`WITHDRAWN`. Credit resolutions must reference a **posted credit note** for
the same customer - the dispute never edits the invoice; the credit note
posts and is applied through the normal document flow.

## Effects while open

- The invoice is flagged (`openDisputes` on every invoice view,
  `disputedOnly` list filter, badge on the invoice screen).
- Dunning skips the invoice.
- Write-offs of the invoice are refused (`INVOICE_DISPUTED`).
- The customer's open collection case moves to `DISPUTED` and gets an
  activity; when the last dispute resolves it returns to `CONTACTED`.
- Only one open dispute per invoice.

## API

```text
GET/POST   /api/v1/disputes           filters: customerId, invoiceId, status, openOnly, search   (dispute.manage to create)
GET/PATCH  /api/v1/disputes/:id       status, assignee, resolution, notes, creditNoteId, amount
```

Events: `invoice.disputed`. Notification: `DISPUTE_OPENED` to the assignee
or holders of `dispute.manage`. Audit: CREATE / UPDATE on `InvoiceDispute`.
