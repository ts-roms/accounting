# Invoicing

Customer invoices, credit notes and debit notes are `invoices` rows with a
`documentType`. Business status and accounting status stay separate:

```text
business   DRAFT ─submit─▶ SUBMITTED ─approve─▶ APPROVED ─post─▶ (PARTIALLY_PAID ─▶ PAID | WRITTEN_OFF)   VOID
accounting UNPOSTED ──────────────────────────────────────post─▶ POSTED ──void──▶ REVERSED
```

`OVERDUE` is derived (`daysOverdue > 0` on an open posted document), never a
stored status; `CANCELLED` is a void of an unposted document.

## Validation at create / update

Customer active - currency = customer currency - document rate resolved via
`ExchangeRatesService.documentRate` - line accounts postable -
`DocumentStockService.validateLines` (products / warehouses) -
`DimensionsService.validateRefs` - `TaxEngineService.applyToLines` (tax
codes, rates, withholding) - draft-time period check
(`resolvePeriod(..., { draft: true })`) - due date from the payment term
(`paymentTermId` on the document, else the customer's term, else net days) -
sales-order / delivery fulfilment consumed inside the same transaction.

## Submit and approve

- `POST /invoices/:id/submit` (`invoice.create`): DRAFT -> SUBMITTED, runs
  the `INVOICE` credit rules (BLOCK refuses; the rest become `warnings`) and
  opens an `INVOICE` approval workflow when one matches. Approvers are
  notified (`APPROVAL_REQUIRED`).
- `POST /invoices/:id/approve` (`invoice.approve`): from DRAFT or SUBMITTED;
  `ApprovalsService.assertApproved`, credit rules again, then
  `AuthorityService.assert` for delegated approvals (scope, amount, self-
  approval, usage recorded). Notifies posting users (`INVOICE_APPROVED`).

## Posting

`POST /invoices/:id/post` (`invoice.post`) is idempotent and builds one
event for `AccountingPostingService.postEvent`:

```text
Invoice / debit note           Credit note (mirror)
Dr Accounts receivable (control, mapped ACCOUNTS_RECEIVABLE)
   Cr Revenue lines (line accounts, dimensions)
   Cr Output tax (TaxEngineService.postingLines)
   Cr Withholding (negative, when applicable)
Dr COGS / Cr Inventory for stocked lines (DocumentStockService) - skipped when the invoice bills a delivery
```

Foreign-currency documents post in base at the document rate; the control
line carries the exact sum. `TaxEngineService.record` writes the tax
register. Events: `invoice.posted`, `credit_note.posted`,
`debit_note.posted`; notification `INVOICE_POSTED`.

## Void

`POST /invoices/:id/void { reason, reversalDate? }` refuses settled
documents, reverses the journal and stock (posted documents), releases order /
delivery fulfilment, cancels pending approval requests and emits
`invoice.voided` (posted) or `invoice.cancelled` (unposted).

## Credit notes

Post like invoices (mirrored) and settle open invoices through
`POST /invoices/:id/apply` (allocations, realized FX). Alias resources
`/api/v1/credit-notes` and `/api/v1/debit-notes` list / create the
respective type. Disputes resolved with `CREDIT_NOTE` reference the posted
credit note.

## Lists and views

`GET /invoices` filters: `partyId`, `documentType`, `status`, `from`, `to`,
`openOnly`, `overdueOnly`, `disputedOnly`, `branchId`, `salesOrderId`,
`search`. Views include `balance`, `daysOverdue`, `openDisputes`,
`deliveryNumber`, `salesOrderNumber`, `journalNumber`.
