# Consolidation readiness (hardening H9)

Phase 8 gave the platform intercompany transactions and a quick group trial
balance (every active company combined by account code at one closing rate).
H9 turns that into a consolidation process: named groups with ownership and
method, a group chart of accounts fed by member mappings, current-rate
translation with a cumulative translation adjustment, automatic intercompany
eliminations plus manual group adjustments, non-controlling interests, a
readiness checklist and finalised, reproducible runs. Nothing in the module
posts to a company ledger; every figure is read from posted journals.

## Groups

`consolidation_groups` (organization-level): code, name, presentation
currency, parent company. `consolidation_group_members` lists every member
with `ownershipPct` and `method`:

| Method          | Balances carried                         | NCI                                                      |
| --------------- | ---------------------------------------- | -------------------------------------------------------- |
| `FULL`          | 100% of the member                       | `(100 - pct)%` of net assets and of the result, reported |
| `PROPORTIONATE` | `pct%` of every balance (joint ventures) | none                                                     |

The parent is always a FULL member at 100%. Under PROPORTIONATE consolidation
the intra-group pair no longer mirrors (the venturer's share of a receivable
against the full payable), so `INTERCOMPANY_BALANCED` fails until the
difference is booked as an adjustment - that is the correct treatment, not a
defect.

## Group chart of accounts and mappings

`group_accounts` are the rows of the consolidated statements (code, name,
type, `isIntercompany`). `group_account_mappings` map each postable member
account to one group account. `POST /consolidation/groups/:id/mappings/auto
{ createMissing }` maps by code - with `createMissing` it builds the group
chart from the members' charts, the parent's codes first, copying the
intercompany flag. Mapping a member account to a group account of a different
type is refused. Member accounts with a balance but no mapping appear as
`unmapped` on the report and fail readiness.

## Translation (current-rate method)

Per member, from `ExchangeRatesService.rateFor`:

- **closing** rate on the window's last day - balance-sheet accounts
  (cumulative balance to `to`), including equity;
- **average** rate - arithmetic mean of the closing rates at each month end
  inside the window - the window's P&L activity; P&L activity of the year
  before the window (still on the accounts before a year-end close) is
  translated at closing.

Equity at historical rates would need acquisition data the ledger does not
hold, so the **cumulative translation adjustment** is the plug that keeps the
translated member balanced:
`CTA = assets - liabilities - equity - earnings` (all translated). The group
CTA is the sum over members and is reported in `totals`; the consolidated
balance sheet closes as `assets = liabilities + equity + net income + CTA`.
Pure arithmetic lives in `modules/consolidation/group-consolidation.logic.ts`.

## Eliminations and adjustments

- Group accounts flagged `isIntercompany` are eliminated automatically
  (`eliminations = -combined`); the elimination check sums debit-side minus
  credit-side intercompany balances and must be zero.
- `consolidation_adjustments` are balanced, group-level entries in the
  presentation currency (investment against subsidiary equity, unrealised
  profit, reclassifications). They apply to every window containing
  `effectiveDate`; with `recurringUntil` they also apply to later windows up
  to that date. `consolidated = combined + eliminations + adjustments`.

## Report

`GET /consolidation/groups/:id/report?from&to` returns members (rates, CTA,
NCI), rows per group account (`byCompany`, `combined`, `eliminations`,
`adjustments`, `consolidated`), `unmapped`, the applied `adjustments` and
`totals` (assets, liabilities, equity, NCI, CTA, revenue, expenses, net
income, net income to NCI, elimination check, `adjustmentsBalanced`,
`balanced`).

## Readiness

`GET /consolidation/groups/:id/readiness?from&to`:

| Key                     | Result                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `MEMBERS`               | PASS with 2+ members, WARN with only the parent                                      |
| `RATES`                 | FAIL when a foreign member has no closing / average rate                             |
| `PERIODS`               | WARN when a member's fiscal period covering `to` is still OPEN (soft close accepted) |
| `INTERCOMPANY_POSTED`   | FAIL when an intra-group transaction in the window is still DRAFT                    |
| `MAPPINGS`              | FAIL when a member account with a balance is unmapped                                |
| `INTERCOMPANY_BALANCED` | FAIL when the elimination check is not zero                                          |
| `ADJUSTMENTS`           | FAIL when the applied adjustments do not balance                                     |
| `BALANCED`              | FAIL when the consolidated balance sheet does not close                              |

`ready` is true when no check FAILs (WARNs do not block).

## Runs

`POST /consolidation/groups/:id/runs { from, to }` stores a `DRAFT`
`consolidation_runs` row holding the full report and readiness result -
a reproducible snapshot with the rates that were used. `POST
.../runs/:runId/finalize` marks it `FINAL` only when every readiness check
passed at the time of the run (422 `CONSOLIDATION_NOT_READY` with the
failing keys otherwise) and is audited as `FINALIZE`. Final runs are never
edited; run again for a new snapshot.

## UI

- Reporting → **Consolidation** (`/reports/consolidation`): group and window
  pickers; tabs Report (totals, members with rates / CTA, rows), Readiness,
  Adjustments (book / delete), Runs (store, finalise); the Phase 8 quick trial
  balance remains as its own tab.
- Administration → **Consolidation groups** (`/admin/consolidation-groups`):
  create groups with members / share / method, auto-map or hand-map each
  member's chart onto the group chart, deactivate.

## Permissions

| Permission             | Purpose                                                              | System roles                                            |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `consolidation.view`   | Groups, mappings, report, readiness, runs (existing)                 | every read role                                         |
| `consolidation.manage` | Groups / members, group chart, mappings, adjustments, runs, finalise | ACCOUNTING_ADMIN, ACCOUNTANT, FINANCE_MANAGER (+ SUPER) |

## Limitations

- Equity method (associates) is not implemented; only FULL and PROPORTIONATE.
- Investment-in-subsidiary elimination, goodwill and unrealised intra-group
  profit are booked as manual adjustments; the engine does not derive them.
- Equity is translated at closing (no historical rates) - the CTA absorbs the
  difference, which is disclosed but not split by cause.
- The average rate is a mean of month-end closing rates, not a
  transaction-weighted average.
- Reports are built from member ledgers on request; runs snapshot the result
  but are not re-derivable if a member's period is later reopened and
  re-posted (readiness warns while periods are open).
