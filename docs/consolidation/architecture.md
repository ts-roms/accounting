# Multi-entity consolidation & intercompany - architecture

Prompt #9 turns the Phase 8 quick group trial balance into a group close:
a consolidation group with members (full, proportional or equity method),
data-driven elimination rules, fiscal-year-to-date consolidation runs with
their own consolidation ledger, currency translation with a cumulative
translation adjustment, non-controlling interest, consolidated statements,
intercompany settlement and reconciliation, group-close readiness and
integrity checks.

## Module layout (`apps/api/src/modules/consolidation`)

| File                                     | Responsibility                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consolidation.logic.ts`                 | Pure engine: translation (closing / average / historical, CTA plug), rule-driven eliminations, NCI, equity pickup, `consolidate` (group TB + totals), helpers. |
| `consolidation-groups.service.ts`        | Groups, members, elimination rules; resolves the group's posting codes from the parent's account mappings.                                                     |
| `consolidation-runs.service.ts`          | Runs: create / prepare (read member ledgers, run the engine, store adjustments), manual adjustments, finalize / reopen, statements, readiness.                 |
| `intercompany-reconciliation.service.ts` | Open intercompany register by company pair and per-entity ledger-vs-register drift.                                                                            |
| `consolidation-integrity.service.ts`     | Read-only assertions (see `integrity.md`).                                                                                                                     |
| `intercompany.service.ts`                | Phase 8 charges (mirrored entries) plus Prompt #9 cash settlement through both banks.                                                                          |
| `consolidation.service.ts`               | Phase 8 quick group trial balance (kept; `/consolidation/trial-balance`).                                                                                      |
| `consolidation-groups.controller.ts`     | `/consolidation/groups`, `/consolidation/runs`, `/consolidation/intercompany-reconciliation`, `/consolidation/integrity`, `/intercompany/:id/settle`.          |

## Accounting decisions

- **Members' ledgers are read, never written.** A run reads each member's
  chart and `GeneralLedgerService.activity` (cumulative at period end,
  cumulative at period start, activity for the year) and keeps everything
  the group adds in its own tables (`consolidation_adjustments` /
  `_lines`, by account _code_). No journal is posted to any entity by a
  consolidation.
- **Runs are fiscal-year-to-date.** The balance sheet needs the whole
  year's profit to balance, so `periodStart` is always the parent's fiscal
  year start and the income statement is year-to-date; a monthly view is
  the difference between two runs. One run per group and period end;
  reopen instead of duplicating.
- **Translation** (`CURRENT_RATE`): assets and liabilities at the closing
  rate, equity at the historical rate (member override, else the rate on
  the acquisition date, else the opening rate), profit and loss at the
  average of month-end rates in the window. The member column is then
  balanced by a cumulative translation adjustment line in the group's CTA
  account. `CLOSING_RATE` translates everything at closing (no CTA - the
  Phase 8 behaviour). Overrides per run are stored beside the rates used.
- **Eliminations are rules, not code.** `INTERCOMPANY_BALANCES` reverses
  every balance-sheet account flagged `isIntercompany` and books the
  residual (timing, FX) to the intercompany difference account;
  `INTERCOMPANY_PROFIT_LOSS` does the same for configured revenue / expense
  codes (use dedicated intercompany accounts); `INVESTMENT_EQUITY`
  eliminates the parent's investment against the subsidiary's equity at
  acquisition (share capital first, then reserves), books goodwill (or a
  bargain-purchase credit to retained earnings) and non-controlling
  interest at acquisition, adds the outside shareholders' share of reserves
  earned since, and picks up the group's share of equity-accounted results
  (Dr investment / Cr share of associate profit); `UNREALIZED_PROFIT` and
  `CUSTOM` post their template amounts. Rule-driven adjustments are
  regenerated on every preparation; manual ones stay until voided.
- **Non-controlling interest in the current year is an allocation, not a
  journal.** The ledger carries NCI at acquisition plus the share of
  post-acquisition reserves; the outside share of this year's profit is
  computed (`profitAttributableToNci`) and presented in the statements
  (NCI line, profit attributable to the parent), which is how group
  accounts read.
- **Finalizing freezes the inputs.** A finalized run stores the member
  rows it consolidated (`snapshot`) and the rates; it is served from the
  snapshot afterwards, so a group close is reproducible even if an entity
  reopens a period. The `FINALIZED_RUN_DRIFT` integrity check reports
  when the live books no longer match, and reopening (four-eyes, latest
  run first) discards the snapshot.
- **Intercompany settlement is one transaction across two ledgers**: the
  originating company posts Dr intercompany payable / Cr bank, the
  receiving company Dr bank / Cr intercompany receivable
  (`INTERCOMPANY_SETTLEMENT` on both sides), clearing exactly what each
  leg booked. Intercompany numbers are per originating company (like every
  other document).
- **Policy is data.** Presentation currency, translation method,
  intercompany tolerance, whether member periods must be closed, and the
  group's posting codes (defaulted from the parent's mappings
  `INVESTMENT_IN_SUBSIDIARIES`, `GOODWILL`, `NON_CONTROLLING_INTEREST`,
  `CUMULATIVE_TRANSLATION_ADJUSTMENT`, `INTERCOMPANY_DIFFERENCE`,
  `SHARE_OF_ASSOCIATE_PROFIT`, `RETAINED_EARNINGS`) live on the group.

## Controls

- Permissions: `consolidation.view` (all reads), `consolidation.manage`
  (groups, members, rules), `consolidation.run` (open / prepare runs,
  adjustments), `consolidation.approve` (finalize / reopen, delegable).
- Finalize: readiness blockers empty, TB balanced, workflow
  `CONSOLIDATION_RUN` (amount = total assets) approved when configured,
  `AuthorityService.assert(consolidation.approve)`, SoD
  `consolidation.run` vs `consolidation.approve` against the preparer
  (WARN by default).
- Structure changes never rewrite history: adding / removing members while
  a finalized run covers the date is refused; member edits apply to the
  next preparation only.
- Events `consolidation.finalized`, `consolidation.reopened`,
  `intercompany.settled`; notifications `CONSOLIDATION_FINALIZED`,
  `CONSOLIDATION_REOPENED`; API scope `consolidation:read`.

## Web

Group section: Consolidation Groups (list + detail with members, rules,
readiness, policy, runs), Consolidation Runs (list + detail: trial balance
by member column, consolidated statements, consolidation ledger, members
and rates, lifecycle), Intercompany (Phase 8 register plus the **Settle in
cash** action), Intercompany Reconciliation (+ integrity report), Group
Trial Balance (Phase 8 quick view). Hooks in `lib/api/consolidation-hooks.ts`.

## Seed

`seed/consolidation.seed.ts`: new parent-chart accounts (`1700` Investment
in Subsidiaries, `1710` Goodwill, `3400` Non-controlling Interest, `3500`
CTA, `4950` Share of Profit of Associates, `4980` / `6970` Intercompany
Management Fees flagged intercompany, `6980` Intercompany Difference) and
mappings; Acme Trading acquires 80% of Acme Services on 2026-01-05 through a
share swap (Dr 1700 / Cr 3100, no cash); Acme Services trades May-August
and pays a 60,000 management fee through the intercompany register, settled
in July; group `ACME-GROUP` (parent ACME, ACMS 80% full, acquisition equity
200,000, investment 180,000 -> goodwill 20,000, NCI 40,000) with the
`IC-BALANCES`, `IC-FEES` and `INVESTMENT` rules and `requirePeriodsClosed`
off for the demo. Nothing is dated in September 2026 and nothing
P&L-affecting lands before May 2026 in either company.
