# Multi-currency

Sources: `modules/accounting/journals/fx-lines.logic.ts`, `modules/fx/`
(exchange rates, realized / unrealized FX), `packages/money`.

## Principle

```
Transaction currency  ->  exchange rate  ->  base currency
(document / lines)        (rate table or explicit)   (journal lines, ledger, reports)
```

- Every journal line is stored in the **company base currency**; the ledger,
  trial balance and statements are single-currency by construction.
- Foreign amounts stay on the document (invoices, bills, payments carry
  `currency`, `exchange_rate` and base amounts) and, for manual journals, on
  the lines (`foreign_debit`, `foreign_credit`, `exchange_rate`).
- Rates come only from `ExchangeRatesService.rateFor / documentRate`
  (organization rate table, latest quote on or before the date, direct or
  inverted) or an explicit override on the document; conversion uses
  `Money.convert` (half-even to 4 places).

## Foreign-currency manual journals

`POST /api/v1/journal-entries` with `transactionCurrency: "USD"` (and optional
`exchangeRate`): the lines are entered in USD and must balance in USD. The
engine converts each line at one rate, keeps the USD amounts beside the base
amounts and stores `transaction_currency` / `exchange_rate` on the header.
Because lines round independently, the base totals can differ by a few minor
units; that residue is absorbed by the last line of the short side so the base
entry balances exactly (`convertForeignLines`, unit tested). A reversal mirrors
the foreign amounts too. Editing a foreign draft re-converts from the amounts
as entered.

Every line that carries a foreign amount names its currency
(`journal_lines.foreign_currency`); manual foreign journals set it on every
line, document postings set it on the lines that hit a currency-bound
account. The integrity checker flags headers whose currency is not the base
or whose foreign lines lack a transaction currency (`INVALID_CURRENCY`).

## Currency-bound accounts (foreign-currency bank accounts)

An account with its own `currency` (a USD bank account, say) only takes
lines that carry their amount in that currency (`CURRENCY_MISMATCH`
otherwise), so its **foreign balance is always the sum of the foreign amounts
on its lines** (`GeneralLedgerService.foreignActivity`) while its base
balance is the ledger like any other account. Nothing is stored twice.

- A bank account in a foreign currency must book to a GL account bound to
  that currency (`BankingService.createAccount`); its view carries
  `ledgerBalance` (base), `foreignBalance` and `baseCurrency`, and
  statements reconcile against the foreign balance
  (`BankingService.bookBalance`).
- Bank transactions on such an account carry `exchangeRate` (override or the
  table on the transaction date) and `baseAmount`; the journal books the base
  amount with the foreign amount on the bank line. Direct transfers stay in
  one currency - a cross-currency move is a treasury transfer.
- Customer and vendor payments into a bound account must be in its currency
  (`foreignLineFields` in `journals/foreign-line.ts` puts the document amount
  on the bank line); a base-currency bank account takes a document in any
  currency, converted at the payment rate as before.
- Treasury transfers and lease instalments carry the foreign amount on the
  bank leg the same way.

## Exchange differences

## Exchange differences

- **Realized** gains / losses arise on settlement: `FxService` posts the
  difference between the document rate and the payment rate to the `FX_GAIN` /
  `FX_LOSS` mappings inside the payment transaction, with its own source
  identity per settlement.
- **Unrealized** gains / losses: period-end revaluation
  (`POST /api/v1/fx/revaluations`) restates every monetary item at the
  closing rate to `UNREALIZED_FX_GAIN` / `UNREALIZED_FX_LOSS`, posted as an
  auto-reversing entry (reversed on the first day of the next period) so the
  next settlement realizes the true difference. Monetary items (`FX_SIDES`):
  open receivables (`AR`) and payables (`AP`) per document, foreign-currency
  bank balances (`BANK`, per bound GL account: foreign balance x closing rate
  less the base balance; the revaluation line carries a zero foreign amount
  so the foreign balance is untouched) and foreign-currency lease liabilities
  (`LEASE`, per lease: liability x closing rate less the register's base
  carrying amount). Deferred revenue, right-of-use assets and other
  non-monetary balances stay at their historical rate and never revalue.
  `fx_adjustments` records every effect per side; the subledger, bank and
  lease checks subtract it so the register can be compared with the ledger
  on the revaluation date itself.

## Foreign-currency payroll

Employees and pay runs have a pay currency; a run takes the employees paid in
it. Company pay items are base-currency policy (fixed amounts, contribution
caps, bracket tables) converted at the run's period-end rate - brackets are
read on the base-converted taxable pay - while per-employee assignments and
run inputs are entered in the pay currency. Payslip lines carry a base
amount; the payroll journal is the sum of those, so it ties to the run's base
net exactly. Payment settles the payable at the run's base and books the
difference to the cash (at the payment rate) as realized FX. See
`docs/payroll/architecture.md`.

## Foreign-currency leases

A lease has a contract `currency`; its schedule and register carrying figures
are in it, while the ledger holds base (`liability_balance_base`,
`rou_cost_base`, `rou_accumulated_depreciation_base`, per-line
`depreciation_base` / `interest_base`, per-event `*_change_base`):

| Event         | Base measurement                                                                                                                                                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commencement  | Liability and right-of-use asset at the commencement rate (override or the table); base depreciation per month fixed then, plugged to the base cost.                                                                                                                                      |
| Run           | Interest at the rate on the run's period end (a charge of the period); depreciation from the historical base.                                                                                                                                                                             |
| Instalment    | Cash at the payment rate; the liability relieved at its **carrying rate** (its share of the base carried, all of it on the final payment) - the difference is realized `FX_GAIN` / `FX_LOSS`. Paid from an account in the contract currency (foreign amount on the bank line) or in base. |
| Remeasurement | The change in the liability at the rate of the effective date, adjusting the right-of-use asset at that rate; the remaining carrying base depreciates over the remaining term.                                                                                                            |
| Termination   | Everything at its base carrying amount; the gain / loss is base.                                                                                                                                                                                                                          |
| Period end    | The liability is a monetary item: revalued to closing rate by the FX revaluation (`LEASE` items), auto-reversing.                                                                                                                                                                         |

The low-value threshold is compared in the contract currency. Reports show
contract-currency figures per lease with base carrying beside them; totals,
the dashboard and the maturity analysis are base (undiscounted payments at
the closing rate).

See [../accounting-engine.md](../accounting-engine.md) (Phase 8) for the
subledger flows and `apps/api/test/enterprise.e2e-spec.ts` for the covered
scenarios.
