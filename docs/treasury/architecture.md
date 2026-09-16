# Cash management & treasury - architecture

Prompt #8 adds a treasury layer on top of banking, receivables and payables.
It never keeps its own balances: every cash figure is the general ledger read
through `BankingService.ledgerBalance`, every movement is a posted journal
through `AccountingPostingService.postEvent`, and every policy is a row.

## Module layout (`apps/api/src/modules/treasury`)

| File                            | Responsibility                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `treasury.logic.ts`             | Pure: forecast buckets and labels, planned-item expansion, probability weighting, `rollForecast`, days cash on hand, payment file renderers (PESONet CSV, pain.001, positive pay), petty cash arithmetic. |
| `treasury-config.service.ts`    | `treasury_settings` (one row per company, created on first read) and `bank_account_profiles`.                                                                                                             |
| `cash-position.service.ts`      | Cash position per bank account as of a date: GL book balance, latest statement, unmatched lines, in-transit legs, profile limits, base conversion.                                                        |
| `cash-forecast.service.ts`      | Rolling forecast from open AR / AP, promises, payment runs, transfers, recurring journals and planned items; snapshots.                                                                                   |
| `bank-transfers.service.ts`     | Inter-account transfers: DRAFT -> APPROVED -> SENT -> SETTLED (or CANCELLED), two journal legs through cash in transit.                                                                                   |
| `payment-files.service.ts`      | Bank payment files for posted vendor payments, with the bank handshake (transmitted / acknowledged / rejected).                                                                                           |
| `petty-cash.service.ts`         | Imprest funds, vouchers (DRAFT -> APPROVED -> POSTED / VOID), replenishment through a bank withdrawal.                                                                                                    |
| `treasury-dashboard.service.ts` | Composes position, forecast, reconciliation backlog, transfers, files and petty cash into KPIs. Stores nothing.                                                                                           |
| `treasury-integrity.service.ts` | Read-only assertions that cash records agree with the ledger (see `integrity.md`).                                                                                                                        |
| `treasury.job.ts`               | Daily sweep: base-case snapshot, below-minimum / shortfall / unsettled / petty-cash-low alerts.                                                                                                           |
| `treasury.controller.ts`        | `/treasury/*` endpoints (see `docs/api.md`).                                                                                                                                                              |

## Accounting decisions

- **Cash in transit is a real account.** A transfer sent debits `CASH_IN_TRANSIT`
  and credits the source bank; settlement debits the destination bank and
  credits cash in transit. An in-flight transfer therefore never inflates
  either bank balance, and the in-transit balance must always equal the base
  amount of the transfers that have left but not yet arrived (an integrity
  check). Bank fees on sending go to `BANK_CHARGES`.
- **Cross-currency transfers realize FX at settlement.** The base value that
  left the source sits in transit; the destination is booked at the amount the
  bank actually credited, converted at the settlement-date rate, and the
  difference goes to `FX_GAIN` / `FX_LOSS` through `FxService.realizedLines`.
  Journal lines stay in base; the document keeps both currencies.
- **Payment files never post.** They package payments that already posted
  (`vendor_payments.status = POSTED`, paid from the file's bank account). A
  payment belongs to at most one live file; a rejected or cancelled file
  releases its payments. The file content is stored with its SHA-256 and only
  served by the download endpoint; the JSON views mask beneficiary accounts.
- **Petty cash is an imprest.** Each fund owns a dedicated cash-on-hand GL
  account. Vouchers post Dr expense lines / Cr fund; replenishment is a bank
  withdrawal (Dr fund / Cr bank, posted by `BankingService`) that marks the
  posted vouchers reimbursed, so by construction `fund GL = imprest -
unreimbursed vouchers`. Voids are reversal journals.
- **Forecasts and planned items never post.** Opening cash is the position;
  AR inflows are weighted by the collection probability of their aging
  bucket (settings), AP outflows use the discount date while the discount is
  open, approved payment runs replace the bills they carry, recurring journals
  contribute when a bank account is on a line, and planned items expand from
  an anchored start date (`Jan 31 -> Feb 28 -> Mar 31`, never drifting).
- **Policy is data.** Horizon, granularity, scenarios (`BASE / OPTIMISTIC /
PESSIMISTIC` factors and inflow delay), the liquidity floor (`max(average
daily outflow x minimum days cash on hand, sum of account minimums)`), the
  transfer approval threshold, warn windows, payment file defaults and the
  petty cash voucher limit live in `treasury_settings`; per-account limits and
  routing in `bank_account_profiles`.

## Controls

- Approvals are delegable (`bank-transfer.approve`, `petty-cash.approve`) and
  go through `AuthorityService.assert`; workflow gating uses
  `ApprovalsService.open / assertApproved` with document types `BANK_TRANSFER`
  and `PETTY_CASH_VOUCHER`.
- SoD: `Bank transfer creator vs approver` and `Petty cash preparer vs
approver` (the latter applied above the fund's voucher limit). Both ship as
  WARN like every default policy - a BLOCK default would make roles holding
  both sides unassignable; an administrator switches them to BLOCK per
  organization.
- Transfers at or below `transferApprovalThreshold` may be sent from draft;
  above it (or when the threshold is null) they must be approved first.
- Posting permissions: `bank-transfer.post` for both legs,
  `petty-cash.post` for vouchers, voids and replenishment.
- Events (`bank_transfer.*`, `payment_file.*`, `petty_cash.*`, `cash.*`) go
  through the outbox; notifications (`CASH_BELOW_MINIMUM`,
  `FORECAST_SHORTFALL`, `BANK_TRANSFER_APPROVAL_REQUIRED`,
  `BANK_TRANSFER_UNSETTLED`, `PAYMENT_FILE_REJECTED`,
  `PETTY_CASH_APPROVAL_REQUIRED`, `PETTY_CASH_LOW`) are deduped per day.

## Web

`components/treasury/*` under the **Treasury** navigation section: cash
dashboard, cash position, cash forecast (with planned items and snapshots),
bank transfers (list + detail with `StepTimeline` and `OperationDialog`
posting), payment files (generate, download, bank handshake), petty cash
(funds, vouchers, replenishment) and settings (policy, account profiles,
integrity report, sweep). Hooks in `lib/api/treasury-hooks.ts`.

## Seed

`seed/treasury.seed.ts` (ACME only) adds two GL accounts (`1180` Cash in Bank
BPI Savings, `1190` Cash in Transit) and the `BPI-SAVE` bank account, then
settings, three profiles, a settled May transfer and a still-unsettled August
sweep, seven planned items, an acknowledged PESONet file for `PAY-LFM-06`, and
the `PCF-HO` fund (imprest 20,000 on `1120`) funded by a May withdrawal with
two posted, one approved and one draft voucher. Nothing is dated in September
2026 and nothing P&L-affecting lands before May 2026 (other e2e suites assert
on those windows); `1140`, `1141`, `1155` and `1160` stay free for the accounting, banking and import
e2e suites that create them.
