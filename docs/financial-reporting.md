# Financial Reporting (design - implemented from Phase 2)

All reports are computed from posted journal lines. No report reads a cached or
manually maintained balance.

## Reports and the phase that delivers them

| Report                                                                     | Source                                                    | Phase                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------- |
| General Ledger (per account, running balance, dimensions)                  | `journal_lines`                                           | 2                         |
| Trial Balance (opening, debit, credit, closing)                            | `journal_lines` grouped by account                        | 2                         |
| Income Statement / P&L                                                     | accounts of type REVENUE, COST_OF_SALES, EXPENSE          | 2                         |
| Balance Sheet / Statement of Financial Position                            | ASSET, LIABILITY, EQUITY + retained earnings roll-forward | 2                         |
| Cash Flow Statement (indirect)                                             | movement analysis of cash accounts and working capital    | 2 (basic), 6 (bank-based) |
| AR / AP Aging                                                              | open invoice/bill balances bucketed by due date           | 3                         |
| Sales / Purchase reports                                                   | documents joined to their postings                        | 3-4                       |
| Inventory valuation                                                        | `inventory_balances` reconciled to inventory GL           | 5                         |
| Fixed asset register & depreciation schedule                               | `fixed_assets`, `depreciation_entries`                    | 6                         |
| Tax reports (VAT input/output, withholding)                                | `tax_transactions`                                        | 7                         |
| Budget vs Actual (amount, variance, variance %)                            | `budget_lines` vs GL by dimension                         | 7                         |
| Profitability by dimension (company/branch/department/cost center/project) | GL lines with dimensions                                  | 7                         |

## Drill-down contract

Every figure exposes the path used to compute it:

```
Statement line -> Account(s) -> GL lines (filters preserved) -> Journal entry -> Source document -> Attachments
```

The API returns, alongside each report row, a `drill` descriptor
(`{ accountIds, from, to, dimensions }`) that the UI turns into a General Ledger
query; the GL row links to `/journal-entries/:id`, which links to its source
document (`sourceType`, `sourceId`).

## Dimensions

Journal lines carry optional `branch_id`, `department_id`, `cost_center_id`,
`project_id`, `customer_id`, `vendor_id`, `product_id`. Reports accept the same
filters as the dashboard (company, branch, department, cost center, project,
date range).

## Exports

CSV/Excel/PDF are generated server-side by BullMQ jobs for large datasets and
delivered through a download endpoint; small exports stream directly.

## Dashboard

The dashboard answers "How much cash do we have? Who owes us? Whom do we owe?
Are we profitable? Where do we spend? Are we over budget? What is overdue? What
changed this month?" using the same report services. Until Phase 2 it shows
only non-financial system metrics and explicit "available in Phase N" markers -
never placeholder numbers.
