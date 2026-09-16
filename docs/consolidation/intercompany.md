# Intercompany charges, settlement and reconciliation

## Charges (`/intercompany`, Phase 8, numbering `ICT` per originating company)

`DRAFT -> POSTED -> SETTLED` (or `REVERSED` from `POSTED`). Posting writes
the originating company's entry (Dr chosen account / Cr `INTERCOMPANY_PAYABLE`)
and the receiving company's mirror (Dr `INTERCOMPANY_RECEIVABLE` / Cr chosen
account) in one transaction, converting at the rate on the transaction date
when base currencies differ. Use dedicated intercompany P&L accounts
(flagged `isIntercompany`, e.g. `4980` / `6970`) so the group's
`INTERCOMPANY_PROFIT_LOSS` rule can eliminate them.

## Settlement (`POST /intercompany/:id/settle`, `intercompany.post` in both companies)

`{ settlementDate, fromBankAccountId, toBankAccountId, reference? }` - the
bank accounts must belong to the originating and receiving company
respectively. Posts, in one transaction:

| Company     | Dr                                     | Cr                                                        |
| ----------- | -------------------------------------- | --------------------------------------------------------- |
| Originating | `INTERCOMPANY_PAYABLE` (charge amount) | bank GL account                                           |
| Receiving   | bank GL account                        | `INTERCOMPANY_RECEIVABLE` (the amount its own leg booked) |

Source type `INTERCOMPANY_SETTLEMENT` on both journals; the transaction
records the settlement date and both journal ids; event
`intercompany.settled`. A settled charge can no longer be reversed.

## Reconciliation (`GET /consolidation/intercompany-reconciliation?asOf&groupId&currency`)

- `pairs[]` - for every originating / receiving pair with posted, unsettled
  charges on or before the date: count, what is owed (originating currency)
  and what was booked as receivable (receiving currency, from the mirror
  journal), both in the presentation currency, the difference and a
  status (`MATCHED`, `DIFFERENCE`, `ONE_SIDED`).
- `entities[]` - per company: the ledger balance of its accounts flagged
  intercompany (asset side / liability side) against what the register
  expects; any difference means something touched those accounts outside
  the intercompany module (manual journal, opening balance, import).
- Used by group-close readiness (`INTERCOMPANY_MATCHED`, within the group's
  tolerance) and by the `INTERCOMPANY_LEDGER_DRIFT` integrity check.
