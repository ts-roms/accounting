# Bank feed integrity

`GET /banking/feed/integrity?asOf` (`bank-account.view`), company-scoped,
same shape as the other integrity reports.

| Check                   | Severity | Assertion                                                                                                                   |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `APPLIED_WITHOUT_MATCH` | CRITICAL | Every applied suggestion other than IGNORE left its statement line `MATCHED` / `RECONCILED` with a `bank_line_matches` row. |
| `STALE_UNMATCHED_LINES` | WARNING  | No unexplained line of an open statement is older than `bank_feed_settings.staleAfterDays`.                                 |
| `RULES_WITHOUT_ACCOUNT` | CRITICAL | Active rules that post name their counterparty account; receipt / payment rules name their party.                           |

The KPI page shows the report under the ageing and rule tables. The treasury
`STATEMENT_DRIFT` check (`docs/treasury/integrity.md`) remains the assertion
that the statement balance agrees with the books once every line is
explained.
