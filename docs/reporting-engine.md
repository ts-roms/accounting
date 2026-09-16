# Reporting engine, journal control center and traceability (hardening H7)

Phase H7 adds a configurable reporting engine on top of the general ledger,
a journal control center for reviewers, and end-to-end traceability from any
journal to the document, party and audit events behind it. Nothing in this
phase writes to the ledger: every figure is read from posted journal lines
(`GeneralLedgerService.activity`) or approved budget versions.

## Report definitions

`report_definitions` stores one JSON layout per report (`code` unique per
company). Four **system definitions** are seeded per company on first use
(`ReportEngineService.ensureSystemDefinitions`, idempotent):

| Code                  | Basis  | Purpose                                                                                      |
| --------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `PL_COMPARATIVE`      | PERIOD | Income statement: current vs prior period (variance, %), year to date, prior year            |
| `BUDGET_VS_ACTUAL`    | PERIOD | Income statement lines against the approved budget, with variance and YTD actual             |
| `BALANCE_SHEET_ASOF`  | AS_OF  | Financial position at the period end vs prior period end and prior year, with a CHECK row    |
| `DEPARTMENT_EXPENSES` | PERIOD | Operating expenses grouped per department (dimension group) against budget, plus unallocated |

System layouts are read-only; copy one (`POST /report-definitions/:id/copy`)
to get an editable custom report. Custom definitions can be renamed,
re-laid-out and deactivated; every change is audited (`ReportDefinition`).

### Layout

```jsonc
{
  "rows": [
    {
      "key": "REVENUE",
      "label": "Revenue",
      "kind": "ACCOUNTS",
      "accounts": { "types": ["REVENUE"] },
      "showAccounts": true,
    },
    {
      "key": "COST_OF_SALES",
      "label": "Cost of sales",
      "kind": "ACCOUNTS",
      "accounts": { "types": ["COST_OF_SALES"] },
    },
    {
      "key": "GROSS_PROFIT",
      "label": "Gross profit",
      "kind": "FORMULA",
      "formula": "REVENUE - COST_OF_SALES",
      "bold": true,
    },
    {
      "key": "BY_DEPT",
      "label": "Opex by department",
      "kind": "DIMENSION_GROUP",
      "dimensionType": "DEPARTMENT",
      "accounts": { "types": ["EXPENSE"] },
    },
  ],
  "columns": [
    { "key": "CURRENT", "label": "Current", "kind": "CURRENT" },
    { "key": "PRIOR", "label": "Prior period", "kind": "PRIOR_PERIOD" },
    {
      "key": "VAR",
      "label": "Variance",
      "kind": "VARIANCE",
      "base": "CURRENT",
      "against": "PRIOR",
    },
    {
      "key": "VAR_PCT",
      "label": "Variance %",
      "kind": "VARIANCE_PCT",
      "base": "CURRENT",
      "against": "PRIOR",
    },
    { "key": "YTD", "label": "Year to date", "kind": "YEAR_TO_DATE" },
    { "key": "BUDGET", "label": "Budget", "kind": "BUDGET" },
    {
      "key": "Q1",
      "label": "Q1",
      "kind": "CUSTOM_RANGE",
      "from": "2026-01-01",
      "to": "2026-03-31",
    },
  ],
  "filters": { "branchId": null, "departmentId": null },
}
```

- **Rows** - `HEADER` (label only), `ACCOUNTS` (an account selector: ids,
  codes, code range, types, subtypes or mapping keys - the union of the
  criteria; header accounts never match), `FORMULA` (`KEY [+|- KEY]...` over
  other rows, evaluated after its inputs), `DIMENSION_GROUP` (one line per
  active value of a dimension type, plus the group total). `sign` presents the
  figure on the account's natural side (`NATURAL`, default), or forces
  `DEBIT` / `CREDIT`. `showAccounts` expands a row into one line per account
  (level 1, with the account id for drill-down); `hidden` computes a row
  without printing it.
- **Columns** - `CURRENT` (the run's `from`-`to`), `PRIOR_PERIOD` (whole
  months shift by the same number of months, other ranges by their length in
  days), `YEAR_TO_DATE` (fiscal-year start of `to` → `to`), `PRIOR_YEAR`,
  `CUSTOM_RANGE`, `BUDGET` (approved budget lines whose fiscal period starts
  inside the window), `VARIANCE` (`base - against`) and `VARIANCE_PCT`
  (2 decimals; null when `against` is zero).
- **Basis** - `PERIOD` reads activity inside each window; `AS_OF` reads all
  history up to the window's end (`from` is null on the result columns), which
  is how the balance-sheet definition balances at every column.
- Validation (`reportLayoutSchema`) rejects duplicate keys, formulas that
  reference unknown rows and variance columns that compare unknown columns.

### Running

`POST /report-definitions/:id/run` and `POST /reports/run` (ad hoc, for the
editor's preview) take `{ from, to, branchId?, departmentId?, costCenterId?,
projectId?, budgetId?, includeZero }`. Run parameters override the layout's
saved filters. The result is `{ definition, currency, params, columns[{key,
label, kind, from, to}], rows[{key, label, kind, level, bold, values, accountId?,
dimensionId?}], generatedAt }` - `values` keyed by column key, money as decimal
strings, `VARIANCE_PCT` as a percentage string. Rows are computed in
dependency order and printed in layout order.

Rows and columns come straight from the ledger read the standard statements
use, so the comparative income statement agrees with
`/reports/income-statement` per column and the as-of balance sheet with
`/reports/balance-sheet` (the e2e suite asserts both).

### UI

Reporting → **Custom Reports** (`/reports/custom`): choose a definition, set
the period, branch, department and budget, run it, drill from account lines
into the general ledger for that column's window, copy a definition, and edit
a custom layout as JSON with a server-side preview before saving.

## Journal control center

Accounting → **Journal Control** (`/accounting/journal-control`). The journal
list gained the filters `branchId`, `sourceType` (`MANUAL` = no source
document), `createdBy`, `approvedBy`, `postedBy`, `minAmount`, `maxAmount`;
`GET /journal-entries/summary` returns, for the same filters, counts and
totals per status and per source module plus the review indicators: manual
journals, entries awaiting approval, self-posted entries (preparer = poster),
reversing / reversed entries. These are counts over `journal_entries`; ledger
figures are never re-derived.

## Traceability

`GET /trace/journal/:id` (`trace.view`) returns:

- the journal with its preparer / approver / poster,
- the **source document** it was posted from (`sourceType` mapped to the
  owning table: invoices, bills, payments, expense claims, bank transactions,
  fixed assets, depreciation runs, goods receipts, deliveries, stock documents,
  intercompany, FX revaluations, recurring runs, prepayment schedules,
  write-offs, journal reversals) with its number, status, amount and web path;
  event suffixes such as `AR_DOCUMENT_VOID` resolve to their base document,
- the **party** (customer, vendor or employee) on that document,
- **related journals**: reversal / correction links and every other journal
  of the same source (`SAME_SOURCE`),
- approval requests on the journal and on its source document,
- the **audit trail** of both (newest first, 200 max).

`GET /trace/document/:sourceId` lists every journal a document produced. The
web shows a _Traceability_ panel on the journal detail page and a _Ledger
postings_ panel on invoice / bill detail pages. `trace.view` is a restricted
view (like `audit.view`): accounting roles, managers and auditors hold it;
viewers do not, because the trace exposes audit events.

## Permissions

| Permission                 | Purpose                                    | System roles                                                    |
| -------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `reports.view`             | List and run report definitions (existing) | every read role                                                 |
| `report-definition.manage` | Create / update / copy definitions         | ACCOUNTING_ADMIN, ACCOUNTANT, FINANCE_MANAGER, MANAGER          |
| `trace.view`               | Journal → document → party → audit trace   | ACCOUNTING_ADMIN, ACCOUNTANT, FINANCE_MANAGER, MANAGER, AUDITOR |

## Limitations

- Formulas support `+` and `-` between rows only (no multiplication, ratios
  or constants); percentage columns exist only as `VARIANCE_PCT`.
- One dimension group level per row (no nested groups) and one dimension
  filter per type per run.
- `BUDGET` columns read the approved version of the budget whose fiscal
  periods start inside the window (or the explicit `budgetId`); budgets are
  not pro-rated for partial periods.
- The layout editor is JSON with schema validation and preview, not a
  drag-and-drop designer. Scheduled distribution and PDF / Excel output are
  not part of this phase (CSV export of the underlying ledger exists).
