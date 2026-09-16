# Financial statements

Source: `apps/api/src/modules/reporting/`. All statements are derived from
posted journal lines through the general-ledger read model; the chart's
hierarchy drives the rows (headers roll up their descendants) and every row
carries a `drill` descriptor. Page: `/reports/financial-statements`
(tabs: Income Statement, Balance Sheet, Cash Flow; `/accounting/cash-flow`
redirects to the Cash Flow tab).

## Income statement

`GET /api/v1/reports/income-statement?from=&to=&branchId=&<dimensions>&compareFrom=&compareTo=`

```
Revenue
- Cost of sales
= Gross profit
- Operating expenses
= Operating income
+ Other income
- Other expenses
= Net income
```

Sections map to account types `REVENUE`, `COST_OF_SALES`, `EXPENSE`,
`OTHER_INCOME`, `OTHER_EXPENSE`. `compareFrom` / `compareTo` return the same
structure for a comparative window under `comparative` (the page offers "same
period last year").

## Balance sheet

`GET /api/v1/reports/balance-sheet?asOf=&branchId=`

```
Assets
Liabilities
Equity
+ Current earnings (unclosed P&L, net credit)
= Total liabilities and equity
```

`balanced` proves `Assets = Liabilities + Equity + current earnings` before and
after year-end close. Amounts are signed by account **type**, so contra accounts
(accumulated depreciation, allowances) present as negatives inside their
section. Retained earnings receive the year's result through the CLOSING
journal (`RETAINED_EARNINGS` mapping) at year end.

## Cash-flow statement

`GET /api/v1/reports/cash-flow?from=&to=&branchId=` - indirect method, pure
logic in `reporting/cash-flow.logic.ts`.

```
Net income
+/- change in every non-cash balance-sheet account      -> OPERATING / INVESTING / FINANCING
= Net change in cash
Opening cash -> Closing cash (accounts with subtype CASH / BANK)
```

Classification: `accounts.cash_flow_activity` when set, else by subtype
(`FIXED_ASSET` -> investing; `LOAN`, `SHARE_CAPITAL`, `RETAINED_EARNINGS`,
`OTHER_EQUITY` and any equity account -> financing; everything else, including
the accumulated-depreciation add-back, working capital, prepaid, accrued and
tax accounts -> operating). Year-end CLOSING journals are excluded so a window
spanning a year end still shows the year's income.

Because every posted entry balances, the classified changes sum exactly to the
cash movement; `balanced` asserts it on every run. The direct method is not
implemented - the statement says `method: "INDIRECT"` and the classification
model is the extension point.

## Verification

- `apps/api/test/accounting.e2e-spec.ts` - trial balance balances, balance
  sheet ties, year-end close zeroes the income statement.
- `apps/api/test/accounting-core.e2e-spec.ts` - other income section,
  comparative P&L, cash-flow reconciliation.
- `apps/api/src/modules/reporting/cash-flow.logic.spec.ts` - unit tests of the
  classification and reconciliation.
