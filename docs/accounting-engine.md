# Accounting Engine

Implemented in Phase 2. Source: `apps/api/src/modules/accounting/`.

## Flow

```
Business Transaction -> AccountingEvent -> Journal Entry -> Journal Lines
        -> General Ledger (read model) -> Trial Balance -> Financial Statements
```

The **general ledger is the only source of financial truth**. Reports are
computed from posted `journal_lines` on demand (`GeneralLedgerService.activity`);
nothing maintains separate totals. `journal_entries.total_debit/total_credit`
are document attributes validated against the lines, not a reporting source.

## Invariants (all covered by `apps/api/test/accounting.e2e-spec.ts`)

| #   | Rule                                                                                 | Where enforced                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `SUM(debit) = SUM(credit)` for every entry, exact decimals                           | `AccountingPostingService.validateLines` (Money), DB CHECK `journal_entries_posted_balanced_chk`                                                            |
| 2   | `debit >= 0`, `credit >= 0`, one side only, never both zero                          | DB CHECKs on `journal_lines` + validation                                                                                                                   |
| 3   | Only ACTIVE, non-header accounts of the same company (and currency) can be posted to | `validateLines`                                                                                                                                             |
| 4   | No posting into a CLOSED period                                                      | `resolvePeriod` -> `ACCOUNTING_PERIOD_CLOSED` (year-end close is the only exception, internal flag)                                                         |
| 5   | Posted entries are immutable (only reversible)                                       | Service state machine + DB triggers `journal_entries_immutable_when_posted`, `journal_lines_immutable_when_posted`, `journal_entries_no_delete_when_posted` |
| 6   | Trial balance debits = credits; Assets = Liabilities + Equity + current earnings     | `ReportingService` (`balanced` flags)                                                                                                                       |
| 7   | Document numbers are unique and sequential per company/type/year                     | `DocumentNumberingService` atomic upsert                                                                                                                    |
| 8   | Posting is idempotent                                                                | `(company, idempotency_key)` and `(company, source_type, source_id)` unique; re-posting a posted entry is a no-op                                           |

## Money

- Storage: `NUMERIC(19,4)`. Transport: decimal **strings** (`"1250.0000"`).
- Arithmetic: `@accounting/money` (`Money` on decimal.js, half-even rounding
  to 4 places, currency-checked, `allocate()` without lost minor units).
  `formatMoney` handles display (grouping, accounting negatives).

## Document lifecycle

```
DRAFT -> SUBMITTED -> APPROVED -> POSTED -> LOCKED (period closed)
  ^          |            |          |
  |          v            v          v
  +------ REJECTED <------+       REVERSED (mirror REVERSAL entry posted)
```

| Transition                                 | Permission        | Rule                                                                          |
| ------------------------------------------ | ----------------- | ----------------------------------------------------------------------------- |
| create / update / delete (DRAFT, REJECTED) | `journal.create`  | balanced, open period, valid accounts                                         |
| submit                                     | `journal.submit`  | from DRAFT/REJECTED                                                           |
| approve                                    | `journal.approve` | SoD: creator != approver (policy `journal.create`/`journal.approve`)          |
| reject                                     | `journal.approve` | reason required, audited                                                      |
| post                                       | `journal.post`    | SoD: approver != poster (policy `journal.approve`/`journal.post`); idempotent |
| reverse                                    | `journal.reverse` | from POSTED/LOCKED; reversal date >= entry date and in an open period         |

Document-level SoD uses the same `sod_policies` data as role assignment:
`BLOCK` rejects with `SOD_VIOLATION`, `WARN` returns `sodWarnings` and records
them in the audit trail.

## AccountingPostingService

```ts
postEvent(tx, event: AccountingEvent, opts?)   // create + post in one step (modules, reversals, year-end)
postEntry(tx, entryId, actorId, opts?)         // post an APPROVED document
validateLines(tx, companyId, currency, lines)  // exact-decimal validation
resolvePeriod(tx, companyId, entryDate, opts?) // period lookup + open check
```

- Never opens its own transaction; the caller's transaction carries both the
  business change and the ledger write.
- Emits `accounting.journal.posted` (`JournalPostedEvent`) through
  `@nestjs/event-emitter` after a successful post.
- Business modules call `postEvent` with `sourceType/sourceId` (e.g.
  `AR_DOCUMENT`, `AR_PAYMENT`, `AP_DOCUMENT_VOID`) and resolve accounts through
  `AccountsService.resolveMapped(companyId, key)`; the unique
  `(source_type, source_id)` index makes posting idempotent.

## Fiscal calendar

- `FiscalPeriodsService.createYear` builds 12 monthly periods from a start date
  (name `FY2026` or `FY2026-27`); overlaps are rejected.
- Periods close **in sequence**; closing requires no DRAFT/SUBMITTED/APPROVED
  entries in the period and locks POSTED entries (`LOCKED`). Reopening
  (`period.reopen`) is only allowed for the latest closed period of an open
  year and unlocks entries. Both are audited (`PERIOD_CLOSE`, `PERIOD_REOPEN`).
- **Year-end close** (`period.close` on the year): all periods must be closed;
  a `CLOSING` journal dated on the last day transfers every income-statement
  account's net balance to the `RETAINED_EARNINGS` mapping; the year becomes
  `CLOSED` and no period can be reopened (`YEAR_CLOSE` audit).

## Reports

- **General ledger**: opening balance (before `from`), lines with a SQL window
  running balance, closing balance; signed by the account's normal side.
- **Trial balance**: per postable account opening / movement / closing split
  into debit and credit columns, totals and `balanced`.
- **Income statement**: revenue, cost of sales, gross profit, expenses, net
  income; rows follow the chart hierarchy with header roll-ups.
- **Balance sheet**: assets, liabilities, equity plus _current earnings_ (net
  credit of unclosed P&L accounts) so `A = L + E` holds before and after
  year-end close. Amounts are signed by the account **type**, so contra
  accounts (accumulated depreciation, allowances) present as negatives.
- Every statement row carries a `drill` descriptor (`accountId`, `from`, `to`)
  the UI turns into a general-ledger query; ledger rows link to the journal
  entry, which links to its source document.
- Every figure starts from `GeneralLedgerService.activity()`. Whole calendar
  months come from the trigger-maintained `account_period_balances` read
  model, partial edge months from the lines; `lineActivity()` is the pure
  line scan the model is proven against (`PERIOD_BALANCES_VS_LEDGER`). See
  `docs/performance.md`.

## Subledgers (Phase 3)

Receivables and payables are **subledgers**: every document keeps its own
balance, and the sum of open balances must always equal the balance of the
mapped control account (`ACCOUNTS_RECEIVABLE` / `ACCOUNTS_PAYABLE`) in the
general ledger. `GET /reports/ar-reconciliation` and `/ap-reconciliation`
compute both sides independently and report the difference; the integration
tests assert it is zero after every lifecycle step.

| Event                               | Journal (AR)                                    | Journal (AP)                        |
| ----------------------------------- | ----------------------------------------------- | ----------------------------------- |
| Invoice / bill posted               | Dr AR control, Cr each line account             | Dr each line account, Cr AP control |
| Credit note posted                  | Dr line accounts, Cr AR control                 | Dr AP control, Cr line accounts     |
| Debit note posted                   | as invoice                                      | as bill                             |
| Receipt / payment posted            | Dr cash account, Cr AR control                  | Dr AP control, Cr cash account      |
| Refund posted                       | Dr AR control, Cr cash account                  | Dr cash account, Cr AP control      |
| Allocation (payment or credit note) | none - settles document balances only           | none                                |
| Void of a posted document / payment | REVERSAL journal (mirror), allocations released | same                                |

Rules:

- Business status (`DRAFT`, `APPROVED`, `PARTIALLY_PAID`, `PAID`, `VOID`) is
  derived from `total` and `allocated_amount` and never touches the ledger;
  accounting status (`UNPOSTED`, `POSTED`, `REVERSED`) only changes through the
  posting service.
- Allocations are validated in exact decimals (`validateAllocations`): the
  target must belong to the same party, be posted and open, and the sum may not
  exceed the payment amount or any document's remaining balance.
- A document with allocations cannot be voided (`DOCUMENT_HAS_ALLOCATIONS`);
  void the payment first, which releases the allocations and reverses the cash
  entry.
- Refunds may not exceed the party's unapplied credit (open credit notes plus
  on-account payments).
- Aging is as-of aware: balances as of a date ignore allocations dated later
  and reversals posted later, so a historical aging report matches the ledger
  on that date.

## Orders and three-way matching (Phase 4)

Quotations, sales orders, purchase requests, purchase orders and goods receipts
**never post**. The ledger effect of a sale or purchase is the AR invoice / AP
bill raised from the order (`POST /sales-orders/:id/fulfil`,
`POST /purchase-orders/:id/fulfil`), created through the Phase 3 services in
the same transaction that updates the order's fulfilment counters. Returns are
credited the same way (credit notes at the order's net prices).

Three-way matching compares a bill with its purchase order and the confirmed
goods receipts:

| Exception                | Raised when                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `QUANTITY_MISMATCH`      | billed > ordered (+ tolerance) or billed > received-and-unbilled (+ tolerance) |
| `PRICE_MISMATCH`         | \|bill price - order price\| > order price x price tolerance                   |
| `MISSING_RECEIPT`        | nothing received for the line and receipts are required before billing         |
| `MISSING_PURCHASE_ORDER` | bill or line not linked to a PO and a PO is required                           |
| `DUPLICATE_INVOICE`      | the AP duplicate check flagged a same-vendor / same-amount bill within 7 days  |

A bill with unreviewed exceptions may be approved and posted (the liability is
real) but cannot be allocated a payment (`MATCH_EXCEPTION_UNREVIEWED`) until a
holder of `bill.match-review` records a review note. Confirming or cancelling a
receipt re-evaluates the PO's open bills; a reviewed bill stays reviewed while
its exception set is unchanged. Tolerances live in `purchasing_settings`.

## Inventory (Phase 5)

Stock is a subledger like AR and AP: `inventory_balances` (quantity and value
per product / warehouse / lot) must equal the inventory control account(s).
Every quantity change goes through `InventoryService.receive` / `issue`, which
value the movement and return its exact cost; the calling document posts the
matching journal lines in the same transaction.

| Event                                     | Journal                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| Goods receipt confirmed (stocked PO line) | Dr inventory (PO net price), Cr goods received not invoiced (GRNI) |
| Bill posted for a received PO line        | Dr GRNI (receipt cost), Dr / Cr purchase price variance, Cr AP     |
| Bill posted for a direct stock purchase   | Dr inventory (bill price), Cr AP (rounding to PPV)                 |
| Invoice posted with a stocked line        | Dr AR / Cr revenue **and** Dr COGS / Cr inventory (issue cost)     |
| Sales credit note with a stocked line     | Dr inventory (current cost) / Cr COGS, Dr revenue / Cr AR          |
| Vendor credit note with a stocked line    | Dr AP, Cr inventory (issue cost), variance to PPV                  |
| Stock adjustment / count variance         | Dr / Cr inventory vs. inventory adjustments                        |
| Stock transfer                            | none - value moves between warehouses at cost                      |
| Void / cancel of any of the above         | stock reversed at the **original value**; mirror REVERSAL journal  |

Valuation (`modules/inventory/valuation.ts`) is pure and deterministic:

- **FIFO** consumes layers oldest first (date, sequence, id); partial layers
  cost `quantity x unitCost` half-even, and issuing the last unit of a balance
  relieves the balance's exact remaining value so no residue is left.
- **Weighted average** issues at `value / quantity`; emptying the balance
  relieves its exact value.
- Negative stock is rejected (`INSUFFICIENT_STOCK`) unless the company allows
  it, in which case the uncovered quantity is costed at the average, standard or
  purchase cost.
- Lot-tracked products need a lot on every movement; serial-tracked products
  need exactly one serial per unit, and a serial can only be issued from the
  warehouse it sits in.

Accounts resolve product -> category -> company mapping (`INVENTORY`,
`COST_OF_GOODS_SOLD`, `INVENTORY_ADJUSTMENT`, `GOODS_RECEIVED_NOT_INVOICED`,
`PURCHASE_PRICE_VARIANCE`). `GET /inventory/valuation` compares the subledger
with each inventory account's ledger balance; the integration suite asserts
they agree after every scenario.

## Fixed assets and banking (Phase 6)

The asset register is a subledger of the asset cost and accumulated
depreciation accounts: `fixed_assets.cost` and `accumulated_depreciation`
change only inside a transaction that posts the matching journal.

| Event                     | Journal                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| Capitalise draft asset    | Dr asset cost, Cr fixed asset clearing (or the chosen postable account)                  |
| Depreciation run posted   | Dr depreciation expense, Cr accumulated depreciation (ADJUSTING, aggregated per pair)    |
| Depreciation run reversed | mirror REVERSAL journal; register and depreciated months restored                        |
| Impairment                | Dr impairment loss, Cr accumulated depreciation (remaining life re-spread)               |
| Upward revaluation        | Dr asset cost, Cr revaluation surplus (equity)                                           |
| Disposal / write-off      | Dr accumulated depreciation, Dr proceeds account, Cr asset cost, gain / loss to disposal |
| Transfer                  | none - location / branch only                                                            |

Depreciation (`modules/fixed-assets/depreciation.ts`) is pure: straight line
divides the remaining depreciable amount by the remaining months; declining
balance applies the annual rate to book value (never below the straight-line
remainder or salvage); the final month absorbs rounding so accumulated
depreciation lands exactly on cost - salvage. Runs post in fiscal-period order
and only the latest posted run can be reversed.

Bank accounts hold no balance of their own - the balance is the GL account's.
Bank transactions post Dr / Cr the bank GL account against the counterparty
(transfers Dr destination / Cr source); void = reversal. Statement matching
(`modules/banking/matching.logic.ts`) is pure: a line matches exactly one
posted ledger line with the same signed amount inside the date tolerance
(reference breaks ties), several candidates are an exception, an identical
earlier line is a duplicate. Each automatic match carries a confidence (HIGH
with reference evidence, MEDIUM otherwise); below the company's
`autoMatchMinConfidence` bar the line becomes `POSSIBLE_MATCH` with the
suggested ledger line for a person to confirm. Reconciliation difference:
`(statement + deposits in transit - outstanding payments) - (ledger + unrecorded
credits - unrecorded debits)`; completion requires zero and every line
explained. A voided transaction and its reversal are excluded from reconciling
items once both are dated on or before the statement date.

Mapping keys: `FIXED_ASSET_COST`, `ACCUMULATED_DEPRECIATION`,
`DEPRECIATION_EXPENSE`, `FIXED_ASSET_CLEARING`, `GAIN_LOSS_ON_DISPOSAL`,
`IMPAIRMENT_LOSS`, `REVALUATION_SURPLUS` (categories may override the first
three).

## Tax, dimensions, budgets and expense claims (Phase 7)

Tax rules are data (`tax_codes` + effective-dated `tax_rates`); the engine
(`modules/tax/tax-engine.service.ts`) computes per-line amounts on the
document date and returns the balancing lines the document posts in its own
entry. Every posted amount is recorded in `tax_transactions`; a void inserts
negated rows pointing at the originals, so a return is a plain SUM over dates.

| Event                                | Journal                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Invoice with sales tax + withholding | Dr AR (total), Cr revenue (net), Cr output tax, Dr creditable withholding         |
| Bill with input tax + withholding    | Dr expense / inventory (net), Dr input tax, Cr AP (total), Cr withholding payable |
| Credit notes / voids                 | mirror of the above; tax transactions negated                                     |
| Expense claim posted (tax-inclusive) | Dr expense (gross - tax) per line, Dr input tax, Cr due to employees (gross)      |
| Expense claim paid                   | Dr due to employees, Cr bank GL account                                           |

`total = subtotal + taxTotal - withholdingTotal` is a database CHECK on
invoices and bills. Tax arithmetic (`tax.logic.ts`) is pure: tax on a net
base is half-even to the currency scale; a tax-inclusive gross splits so that
base + tax equals the gross exactly.

Dimensions (department, cost center, project) are typed references on journal
lines; `DimensionsService.validateRefs` runs inside every writing transaction
(manual journals, subledger documents, budgets, claims). Ledger reads accept
dimension filters, so dimensional statements are the same read model filtered.

Budgets never touch the ledger. Variance = posted journal lines grouped by
account and fiscal period, signed in the account's natural direction, against
the approved version's lines (both sides filtered by the same dimensions).

Mapping keys: `EMPLOYEE_PAYABLE`; tax accounts live on the tax code itself.

## Multi-currency, intercompany, consolidation and approvals (Phase 8)

The ledger stays single-currency: every journal line is in the company base
currency. Foreign amounts live on the subledger document (`currency`,
`exchangeRate`, `baseTotal` / `baseAmount`) and are converted once, at posting,
with `Money.convert` (half-even). Rates are organization-wide data
(`exchange_rates`, NUMERIC(19,8)); `ExchangeRatesService.rateFor` picks the
latest quote on or before the date and inverts a reverse pair
(`EXCHANGE_RATE_MISSING` otherwise). Documents may override the resolved rate.

| Event                                       | Journal (base currency)                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreign invoice / bill posted               | lines converted at the document rate; control = sum of the base lines; `baseTotal` stored                                                             |
| Foreign payment posted                      | Dr bank (base at payment rate) / Cr AR at the document rate; difference = realized FX gain/loss                                                       |
| Later allocation or credit-note application | standalone realized FX entry (`fx.logic.realizedFx`, signed per AR / AP side)                                                                         |
| Void of any of the above                    | reversal of the original entry including its FX lines                                                                                                 |
| Period-end revaluation (`FxService`)        | ADJUSTING entry Dr/Cr control vs `UNREALIZED_FX_GAIN` / `UNREALIZED_FX_LOSS`, auto-REVERSAL next day; `fx_adjustments` keep the signed control effect |

`controlBaseAmount` on a payment is the base amount that actually relieved the
control account (`baseAmount` -/+ the realized gain), so AR / AP reconciliation
is `sum(baseTotal) - sum(controlBaseAmount) + open fx_adjustments = control
balance`; aging reports in base at document / payment rates. Allocations must
share the document currency (`CURRENCY_MISMATCH`).

Intercompany (`IntercompanyService`) posts one event as two mirrored entries:
Dr `fromAccount` / Cr `INTERCOMPANY_PAYABLE` in the lending company and Dr
`INTERCOMPANY_RECEIVABLE` / Cr `toAccount` in the receiving one, in one
transaction; reversal reverses both. The caller must hold `intercompany.post`
in both companies. Consolidation is a read model: each company's trial balance
translated at the closing rate into the presentation currency, with balances
on `is_intercompany` accounts eliminated and an elimination check that must net
to zero.

Approval workflows are data (`approval_workflows`: document type, amount band,
priority, ordered steps with a required permission and approver count).
Submitting a journal, expense claim or purchase order opens the matching
request; `ApprovalsService.assertApproved` gates approve / post
(`APPROVAL_REQUIRED`); rejection or cancellation cancels it. Four-eyes: one
decision per person per request, no self-approval unless the workflow allows
it, and the decider must hold the step's permission (`APPROVAL_NOT_ELIGIBLE`).

Attachments are metadata rows plus files under `STORAGE_DIR` (sha256, sanitized
name, allow-listed MIME types, 15 MB) attached to journals, documents, payments
and claims; they never affect posting.

Mapping keys: `FX_GAIN`, `FX_LOSS` (realized), `UNREALIZED_FX_GAIN`,
`UNREALIZED_FX_LOSS`, `INTERCOMPANY_RECEIVABLE`, `INTERCOMPANY_PAYABLE`.

## AI assistance (Phase 9) - advisory only

The AI module (`modules/ai/`) never writes to the ledger. Its rules live in
`ai.logic.ts` (pure: extraction regexes, history-based classification,
anomaly detectors, question parsing, least-squares forecast) and are covered
by unit tests; the services around them only gather inputs and store results.

| Feature        | What it produces                                                                                    | What a person still does                              |
| -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Intake         | Extracted fields + account hints; a DRAFT bill or claim via `BillsService` / `ExpenseClaimsService` | Corrects fields, picks the vendor, approves and posts |
| Classification | Ranked account (+ tax code) suggestions from posted history                                         | Picks the account on the line                         |
| Anomaly flags  | Fingerprinted flags with severity over posted documents / journals                                  | Confirms or dismisses; fixes the books by reversal    |
| Assistant      | Answers built only from report services, with cited sources                                         | Reads; the assistant refuses advice and unknown asks  |
| Forecast       | Trend + band from monthly posted activity                                                           | Plans; nothing is booked                              |

Scanned images without a model backend: with `OCR_PROVIDER=TESSERACT` the
intake reads photos and scans locally (`OcrService`, tesseract.js - a WASM
engine, no system binary, no network at recognition time; language data is
fetched once into `OCR_CACHE_DIR`, or read from `OCR_LANG_PATH` on air-gapped
hosts) and hands the text to the same heuristic extractor a text upload gets,
so a receipt photo still lands as an EXTRACTED draft with the vendor matched
by TIN. The OCR text is stored as `sourceText` for the reviewer; `provider`
stays `HEURISTIC` (`GET /ai/status` reports `ocr`). With a model backend the
model reads the image itself and OCR is skipped. Scanned PDFs (no text layer)
are not rasterised - upload the page as an image.

Guarantees enforced in code: drafts require the same create permission as a
manual document and inherit numbering, tax, approval and posting rules;
answers are permission-filtered (`reports.view`, `invoice.view`, `bill.view`,
...) and a model backend can only rephrase verified facts; the nightly scan
upserts by fingerprint and touches nothing else. Manual journals on
subledger control accounts (`ACCOUNTS_RECEIVABLE`, `ACCOUNTS_PAYABLE`,
`INVENTORY`, `EMPLOYEE_PAYABLE`) are flagged HIGH because they break the
"control account moves only through its documents" invariant.

## Controls (hardening phase 1)

The gateway now also checks the actor's posting authority, branches, cost
dimensions, the source document and the fiscal period _state_
(`OPEN / SOFT_CLOSED / CLOSED / LOCKED`) before writing; corrections are a
first-class workflow (reversal + linked draft) and `IntegrityService` runs the
invariants over live data. Details and the invariant list:
[accounting-controls.md](accounting-controls.md).

## Chart of accounts

- Types `ASSET, LIABILITY, EQUITY, REVENUE, COST_OF_SALES, EXPENSE`; normal
  balance defaults from the type and can be flipped for contra accounts.
- Header accounts group children (same type) and are not postable; a parent
  that receives children becomes a header, unless it already has activity.
- Accounts with activity or mappings cannot be deleted - deactivate instead.
  System accounts (retained earnings) cannot be deactivated.
- `account_mappings` (`RETAINED_EARNINGS`, `ACCOUNTS_RECEIVABLE`, ... ) are
  the only way business logic resolves accounts.
