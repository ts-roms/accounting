# Consolidation runs, adjustments and statements

## Lifecycle

```
POST /consolidation/groups/:id/runs { periodEnd }   consolidation.run   -> DRAFT, prepared
POST /consolidation/runs/:id/prepare                 consolidation.run   re-read ledgers, regenerate rule adjustments
POST /consolidation/runs/:id/adjustments             consolidation.run   manual entry (balanced, codes from any member chart)
POST /consolidation/runs/:id/adjustments/:aid/void   consolidation.run
POST /consolidation/runs/:id/finalize { note? }      consolidation.approve (delegable, SoD vs preparer) -> FINALIZED + snapshot
POST /consolidation/runs/:id/reopen { reason }       consolidation.approve, latest finalized run only  -> DRAFT
```

Numbering `CON` on the parent company. `periodStart` is derived (fiscal
year start); passing a different one is refused.

## What `GET /consolidation/runs/:id` returns

- `members[]` - each consolidated column: method, ownership, the rates used
  (`closing`, `average`, `historical`, `opening`), translated net income and
  translation adjustment.
- `adjustments[]` - the consolidation ledger: sequence, type
  (`ELIMINATION`, `NON_CONTROLLING_INTEREST`, `EQUITY_PICKUP`, `MANUAL`),
  originating rule, status, lines (`companyId` = member column or null =
  group column, account code / name / type, debit, credit).
- `rows[]` - the consolidated trial balance by account code: `byCompany`
  (translated, natural sign), `combined`, `adjustments`, `consolidated`.
- `totals` - assets, liabilities, equity, revenue, cost of sales, gross
  profit, expenses, net income, NCI account balance, CTA, `difference`
  (assets - liabilities - equity - net income) and `balanced`, plus
  `profitAttributableToNci` / `profitAttributableToParent`.
- `readiness` - the group-close checklist for the run's window (empty once
  finalized).

`GET /consolidation/runs/:id/statements` groups the rows by account type
and subtype into a balance sheet (assets, liabilities, equity with the
NCI line carrying the current-year share, current earnings attributable to
the parent, liabilities and equity) and an income statement (revenue,
cost of sales, gross profit, expenses, net income, attributable to NCI /
to the parent).

## Readiness (`GET /consolidation/groups/:id/readiness?periodStart&periodEnd`)

| Item                   | Blocking                     | Passes when                                                                   |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `PERIODS_CLOSED`       | `group.requirePeriodsClosed` | Every member's fiscal periods in the window are `CLOSED` or `LOCKED`.         |
| `RATES_LOADED`         | yes                          | A closing rate exists for every foreign-currency member on the period end.    |
| `INTERCOMPANY_MATCHED` | yes                          | Per-entity ledger-vs-register differences are within `intercompanyTolerance`. |
| `PRIOR_RUN_FINALIZED`  | no                           | The previous run of the group is finalized.                                   |
| `GROUP_ACCOUNTS`       | yes                          | The group's posting codes exist in the parent chart.                          |

## Worked example (the seed)

Acme Trading (parent) paid 180,000 in shares for 80% of Acme Services when
its equity was 200,000; by August Acme Services has earned 332,000 and
charged / settled a 60,000 management fee.

| Entry                             | Dr                                                               | Cr                                   |
| --------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| IC-FEES                           | 4980 Intercompany fees (ACME) 60,000                             | 6970 Intercompany fees (ACMS) 60,000 |
| INVESTMENT: equity at acquisition | 3100 Share capital (ACMS) 200,000                                | 1700 Investment (ACME) 180,000       |
|                                   | 1710 Goodwill (group) 20,000                                     | 3400 NCI (group) 40,000              |
| Presentation only (no journal)    | NCI share of profit 20% x 332,000 = 66,400; parent share 668,710 |                                      |

The group balance sheet shows goodwill 20,000, NCI 106,400 (40,000 +
66,400), and balances to the cent.
