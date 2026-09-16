# Data infrastructure (hardening phase 6)

Four things a finance team needs before the books can be trusted at scale:
configurable document numbering, a governed way to bring data in (CSV import
engine), a way to take it out (CSV exports) and a controlled opening-balance
process that proves the cut-over position. Code: `apps/api/src/modules/data-infrastructure`
and `modules/accounting/numbering`; web `components/data-infrastructure/*`.

## Document numbering engine

- `numbering_rules` (per company, document type and optionally branch): prefix,
  `format` template, padding (3-12) and `reset_yearly`. Tokens: `{PREFIX}`,
  `{BRANCH}` (branch code), `{YEAR}`, `{YY}`, `{SEQ}` (required). Without a rule
  the engine uses the built-in `<PREFIX>-<YEAR>-<NNNNNN>`.
- `document_sequences` now keys its counters by `(company, type, year, branch)`
  (`NULLS NOT DISTINCT`; `year = 0` for rules that never reset). Allocation is
  one atomic upsert **inside the document's transaction**: two concurrent
  documents never share a number, a rolled-back document rolls its number back
  (no gap), and numbers are never reused - the counter only ever increments.
- Resolution: a rule for the document's branch wins, then the company rule, then
  the default. Documents that carry a branch (journals, invoices, bills,
  receipts, payments, orders) pass it to `DocumentNumberingService.allocate`.
- `GET /numbering-rules` lists the effective rule per document type plus branch
  overrides with the number the next document would receive; `GET
/numbering-rules/preview` never consumes a number; `PUT /numbering-rules`
  creates or replaces a rule (`numbering.manage`); `DELETE /numbering-rules/:id`
  falls back to the company rule. Administration → Document Numbering.
- Duplicate numbers remain impossible by the unique constraints on every
  document table; changing a prefix or format never renumbers issued documents.

## Import engine

`POST /imports` (multipart `file` + `type` [+ `asOfDate`, `branchId`]) parses the
CSV (RFC 4180 parser in `csv.ts`, BOM / CRLF / quoted newlines, 5 MB, 5,000
rows), validates every row and stores rows + errors in `import_jobs` - **the
preview is exactly what will be committed**. Validation is in three layers:
cell rules from `IMPORT_SPECS` (Zod), referential checks against the company
(account codes postable and active, party codes, product categories, bank
accounts), and file-level checks (duplicate codes, balanced journal groups).

| Type                   | Behaviour on commit                                                       |
| ---------------------- | ------------------------------------------------------------------------- |
| `CHART_OF_ACCOUNTS`    | row by row through `AccountsService.create`; parents ordered first        |
| `CUSTOMERS`, `VENDORS` | row by row through the party services                                     |
| `PRODUCTS`             | row by row through `CatalogService.createProduct`                         |
| `OPENING_BALANCES`     | **atomic**: one OPENING draft via `JournalEntriesService.openingBalances` |
| `JOURNAL_ENTRIES`      | **atomic**: all groups as drafts in one transaction (`createIn`)          |
| `BANK_TRANSACTIONS`    | drafts (no ledger effect); every row validated before any is created      |

Financial datasets refuse a file with any invalid row (`IMPORT_INVALID_ROWS`).
Master data may be committed with `skipInvalid: true`; each row records its
outcome (created key or error). `GET /imports/types` and `GET
/imports/templates/:type` (header + example row) need no company. Every commit
writes an `IMPORT` audit row with the counts. Nothing is written by the engine
itself - only through the owning domain services, so posting rules, numbering,
SoD and audit apply as for manual entry. Administration → Data Imports.

Excel is not parsed (CSV only); invoices, bills and inventory movements are not
import types yet.

## Exports

`GET /exports?dataset=...` (`reports.export` **and** the dataset's own view
permission) streams a CSV with a `Content-Disposition` file name and
`X-Export-Rows`. Datasets: `TRIAL_BALANCE`, `GENERAL_LEDGER` (`accountId`),
`JOURNAL_ENTRIES`, `CHART_OF_ACCOUNTS`, `CUSTOMERS`, `VENDORS`, `AR_AGING`,
`AP_AGING`, `AUDIT_LOGS`; filters `from`, `to`, `asOf`, `status`, `search`.
Every export is read through the service that owns the report (nothing is
re-derived) and audited (`EXPORT`, with the filters and row count). Export
buttons sit on the trial balance, general ledger, journal list and audit log
screens.

## Opening balances

General-ledger balances arrive as one OPENING journal (`POST
/journal-entries/opening-balances` or the `OPENING_BALANCES` import); the
subledgers are loaded so every control account is backed by real items at the
cut-over, each offset to `OPENING_BALANCE_EQUITY`:

| Endpoint                            | Effect                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /opening-balances/subledger`  | AR / AP: one posted invoice / bill per legacy open item, single line to opening equity (validated first: active party, date ≤ cut-over; idempotent per item) |
| `POST /opening-balances/inventory`  | one posted stock adjustment per warehouse with reason `OPENING` - Dr inventory / Cr opening equity                                                           |
| `POST /opening-balances/assets`     | `FixedAssetsService.openingBalance`: register, capitalise against equity, book accumulated depreciation (Dr equity / Cr accumulated)                         |
| `GET /opening-balances/report?asOf` | per area: subledger vs control account (from `SubledgerBalancesService`), OPENING journals, the residual in opening equity, trial balance balanced           |

Opening equity carries a credit for assets loaded and a debit for liabilities
and accumulated depreciation; it nets to zero once the equity balances
themselves are booked. Accounting → Opening Balances shows the report and loads
AR / AP items; stock and assets are loaded through the API or the import.

Related fixes: the fixed-asset subledger now counts an asset from the **posting
date of its capitalisation** (was the wall-clock `capitalized_at`), so
back-dated capitalisations and migrated assets reconcile as of the cut-over;
the API's PostgreSQL pool logs an idle-connection error instead of crashing the
process.

## Permissions

`numbering.view/manage`, `import.view/run`, `opening-balance.view/manage`
(`*.view` are in every read role; accounting admin manages all three;
accountant runs imports and loads opening balances), `reports.export` for
exports.

## Known limitations

- Excel files are not parsed; convert to CSV first.
- Invoice, bill and inventory-movement imports are not implemented.
- AR / AP opening items post one document at a time (each its own
  transaction); the load is validated up front and idempotent per item, but
  a failure mid-way leaves the earlier items posted (reported in the result).
- Payment controls beyond the existing ones (duplicate detection, idempotency
  keys, void checks) were not extended in this phase.
