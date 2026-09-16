# Cash position and forecast

## Cash position (`GET /treasury/position?asOf&currency`)

One row per active bank account:

| Field                                                                                                | Source                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bookBalance`                                                                                        | GL balance of the bank account's GL account as of the date (base), re-expressed in the account currency at the asOf rate for foreign-currency accounts. |
| `baseBalance`                                                                                        | The same GL balance in the company base currency (exact, no conversion).                                                                                |
| `statementBalance`, `statementDate`                                                                  | Closing balance of the latest bank statement on or before the date.                                                                                     |
| `unreconciledIn/Out/Count`                                                                           | Statement lines still `UNMATCHED`, `POSSIBLE_MATCH` or `EXCEPTION` dated on or before the date.                                                         |
| `inTransitOut`, `inTransitIn`                                                                        | Transfers that had left the source but not yet reached the destination on the date (`SENT`, or `SETTLED` later than the date).                          |
| `minimumBalance`, `targetBalance`, `overdraftLimit`, `accountType`, `purpose`, `excludeFromPosition` | The account's treasury profile.                                                                                                                         |
| `availableBalance`, `headroom`, `belowMinimum`                                                       | Book + overdraft; book - minimum; book < minimum.                                                                                                       |

Totals (`bookBalance`, `availableBalance`, `inTransit`, `pettyCash` = sum of
active imprests, `unreconciledCount`, `belowMinimum`, `excluded`) skip accounts
flagged `excludeFromPosition` (trust / escrow money that is not the company's
to spend). `byCurrency` and `byBank` group the included accounts.

## Forecast (`GET /treasury/forecast?asOf&horizonDays&granularity&scenario&bankAccountId&save`)

1. **Opening cash** - the position's book balance (or one account's).
2. **Flows** over the horizon:
   - `AR_INVOICES`: posted, open invoices / debit notes at the later of due
     date and asOf, delayed by the scenario's `inflowDelayDays`, weighted by
     the collection probability of their aging bucket (`ar_settings` buckets,
     `treasury_settings.collectionProbabilities`). Open credit notes are
     outflows.
   - `AR_PROMISES`: open promises to pay on their promised date.
   - `AP_BILLS`: posted, open, unheld bills on the discount date while the
     discount is open, else the due date; bills already in a live payment run
     are excluded. Open vendor credits are inflows.
   - `AP_PAYMENT_RUNS`: submitted / approved / executing runs on their payment
     date.
   - `TRANSFERS`: sent transfers arrive at the destination on the expected
     settlement date (for a single-account forecast, sent-but-unsettled
     outflows are already out of the book balance).
   - `RECURRING`: active recurring journal templates with a bank GL account on
     a line, at each occurrence up to the horizon.
   - `PLANNED`: active planned items expanded by frequency from an anchored
     start date (`ONCE / WEEKLY / BIWEEKLY / MONTHLY / QUARTERLY / ANNUAL`).
3. **Scenario** multiplies inflows / outflows by the configured factors.
4. **Roll** through `DAY / WEEK / MONTH` buckets: each opening is the previous
   closing; a bucket breaches when its closing falls under the liquidity floor
   (`minimumCash` = max(average daily outflow over `burnWindowDays` x
   `minimumDaysCashOnHand`, sum of profile minimums)).

The response carries the buckets (with `bySource` keyed `DIRECTION:SOURCE`),
totals, source totals and the largest individual flows. `save=true` (or the
daily sweep) stores a `cash_forecast_snapshots` row for accuracy tracking.

## Planned items (`/treasury/forecast/items`)

Payroll, rent, loan repayments, tax remittances, capex, expected maturities -
anything the ledger cannot see yet. `treasury.forecast-manage` creates,
updates (including `active`) and deletes them; they never post.

## Dashboard (`GET /treasury/dashboard?asOf`)

KPIs: total / available cash, in transit, petty cash imprest, days cash on
hand (`cash / (bank GL credits over the burn window / window days)`), net cash
30 / 90 days, lowest forecast closing and breaches, accounts below minimum;
plus the position, the base-case weekly forecast, unreconciled statement lines
by age, transfers pending approval / in transit / unsettled, payment file
counts and petty cash funds.
