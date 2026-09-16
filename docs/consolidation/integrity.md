# Consolidation integrity

`GET /consolidation/integrity?asOf` (`consolidation.view`), organization-level,
same shape as the other integrity reports.

| Check                                 | Severity | Assertion                                                                                                                          |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `CONSOLIDATION_UNBALANCED`            | CRITICAL | Every run's consolidated trial balance has assets = liabilities + equity + net income.                                             |
| `CONSOLIDATION_ADJUSTMENT_UNBALANCED` | CRITICAL | Every active adjustment's lines have equal debits and credits.                                                                     |
| `FINALIZED_RUN_DRIFT`                 | WARNING  | The member figures a finalized run froze still equal the live ledgers (reopen and re-prepare, or reverse the late entity posting). |
| `GROUP_ACCOUNTS_MISSING`              | CRITICAL | Every active group's posting codes exist in its parent chart.                                                                      |
| `INTERCOMPANY_WITHOUT_JOURNALS`       | CRITICAL | Posted / settled intercompany charges carry both journal legs (and both settlement legs).                                          |
| `INTERCOMPANY_LEDGER_DRIFT`           | WARNING  | Each entity's intercompany accounts agree with the open intercompany register.                                                     |

The web surfaces the report under Intercompany Reconciliation; the group
close readiness list (`docs/consolidation/runs-and-statements.md`) is the
forward-looking counterpart.
