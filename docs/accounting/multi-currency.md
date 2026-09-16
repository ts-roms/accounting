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

Accounts with their own `currency` only accept journals in that currency
(`CURRENCY_MISMATCH`). The integrity checker flags headers whose currency is
not the base or whose foreign lines lack a transaction currency
(`INVALID_CURRENCY`).

## Exchange differences

- **Realized** gains / losses arise on settlement: `FxService` posts the
  difference between the document rate and the payment rate to the `FX_GAIN` /
  `FX_LOSS` mappings inside the payment transaction, with its own source
  identity per settlement.
- **Unrealized** gains / losses: period-end revaluation
  (`POST /api/v1/fx/revaluations`) revalues open foreign-currency balances at
  the period-end rate to `UNREALIZED_FX_GAIN` / `UNREALIZED_FX_LOSS`, posted as
  an auto-reversing entry (reversed on the first day of the next period) so
  the next settlement realizes the true difference.

See [../accounting-engine.md](../accounting-engine.md) (Phase 8) for the
subledger flows and `apps/api/test/enterprise.e2e-spec.ts` for the covered
scenarios.
