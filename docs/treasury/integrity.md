# Treasury integrity and the daily sweep

## `GET /treasury/integrity?asOf` (`treasury.view`)

Read-only, same shape as the accounting / AR / AP integrity reports
(`status`, `findings[] { check, severity, title, count, samples, detail }`).

| Check                       | Severity | Assertion                                                                                                                    |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `IN_TRANSIT_VS_LEDGER`      | CRITICAL | `CASH_IN_TRANSIT` GL balance as of the date = base amount of transfers sent on or before the date and not yet settled by it. |
| `TRANSFERS_WITHOUT_JOURNAL` | CRITICAL | Every `SENT` transfer has its out leg; every `SETTLED` transfer both legs.                                                   |
| `UNSETTLED_TRANSFERS`       | WARNING  | No `SENT` transfer is past its expected settlement by more than `unsettledTransferWarnDays`.                                 |
| `PETTY_CASH_OVERSPENT`      | CRITICAL | Unreimbursed posted vouchers never exceed a fund's imprest.                                                                  |
| `VOUCHERS_WITHOUT_JOURNAL`  | CRITICAL | Posted vouchers carry a journal.                                                                                             |
| `PETTY_CASH_LEDGER_DRIFT`   | WARNING  | Fund GL = imprest - unreimbursed vouchers as of the date.                                                                    |
| `PAYMENT_FILE_TOTALS`       | CRITICAL | `totalAmount` / `paymentCount` equal the file lines.                                                                         |
| `PAYMENT_IN_SEVERAL_FILES`  | CRITICAL | A payment is in at most one live (`GENERATED / TRANSMITTED / ACKNOWLEDGED`) file.                                            |
| `FILE_PAYMENT_NOT_POSTED`   | CRITICAL | Live files carry only posted payments.                                                                                       |
| `STATEMENT_DRIFT`           | WARNING  | Latest statement balance = book + unmatched inflows - unmatched outflows (timing differences expected).                      |
| `ACCOUNTS_BELOW_MINIMUM`    | WARNING  | Included bank accounts hold their profile minimum.                                                                           |
| `TREASURY_ACCOUNT_MAPPINGS` | WARNING  | `CASH_IN_TRANSIT`, `BANK_CHARGES`, `FX_GAIN`, `FX_LOSS` are mapped (needed before the matching feature is used).             |

## Daily sweep (`treasury-sweep`, maintenance queue, every 24h; `POST /treasury/sweep?asOf` with `treasury-settings.manage`)

Per active company:

1. Compute the position and the base-case forecast over the configured
   horizon and **save a snapshot** (`createdBy` null = system).
2. For each included account below its minimum: `cash.below_minimum` event +
   `CASH_BELOW_MINIMUM` notification to holders of `bank-transfer.create`.
3. If any bucket breaches the floor: `cash.forecast_shortfall` event +
   `FORECAST_SHORTFALL` notification (`ERROR`) to `treasury.forecast-manage`.
4. For each transfer overdue for settlement: `BANK_TRANSFER_UNSETTLED` to
   `bank-transfer.post`.
5. For each active fund due for replenishment: `PETTY_CASH_LOW` to the
   custodian and `petty-cash.post`.

All events and notifications are deduped per document and day, so re-running
the sweep is safe. The sweep never posts or moves money; the result
(`belowMinimum`, `forecastBreaches`, `unsettledTransfers`, `pettyCashLow`,
`snapshotId`) is returned to the caller and logged.
