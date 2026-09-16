# Accounting integrity, suspense, reconciliation and audit

## Integrity checker

`GET /api/v1/integrity?asOf=` (`integrity.check`), source
`modules/accounting/integrity/integrity.service.ts`, page
`/accounting/integrity`. Every check is read-only and returns a count with up
to 20 samples for drill-down; the report status is the worst failing
severity.

| Check                                           | Severity | Asserts                                                                      |
| ----------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| `UNBALANCED_JOURNAL`                            | CRITICAL | every ledger entry balances on its lines and header                          |
| `PERIOD_MISMATCH`                               | CRITICAL | the period on the entry covers its date                                      |
| `POSTED_IN_CLOSED_PERIOD`                       | CRITICAL | nothing posted after its period closed (year-end routine excepted)           |
| `LINES_ON_BAD_ACCOUNTS`                         | CRITICAL | no lines on header / inactive / foreign-company accounts                     |
| `ORPHAN_LINES`                                  | CRITICAL | every line has a header                                                      |
| `INVALID_CURRENCY`                              | CRITICAL | headers are in the base currency; foreign lines have a transaction currency  |
| `INVALID_DIMENSION`                             | CRITICAL | dimension references exist, belong to the company and have the right type    |
| `DIMENSION_RULE`                                | WARNING  | posted lines satisfy the active dimension rules                              |
| `ACCOUNT_BRANCH`                                | WARNING  | branch-restricted accounts only carry lines of their branches                |
| `DUPLICATE_SOURCE`                              | CRITICAL | one ledger entry per (source type, source id)                                |
| `STATEMENTS_BALANCE`                            | CRITICAL | trial balance balances and Assets = Liabilities + Equity                     |
| `MISSING_MAPPING`                               | WARNING  | required account mappings exist                                              |
| `SUBLEDGER_AR/AP/INVENTORY/FIXED_ASSETS/TAX`    | CRITICAL | subledger balances equal their control accounts (`SubledgerBalancesService`) |
| `DUPLICATE_VENDOR_INVOICE`, `DUPLICATE_PAYMENT` | WARNING  | duplicate controls                                                           |
| `NEGATIVE_STOCK`                                | WARNING  | no negative stock where forbidden                                            |

The same invariants are asserted by the e2e suites after every scenario.

## Suspense monitoring

`GET /api/v1/accounting/suspense?asOf=` (`journal.view`), page
`/accounting/suspense`. Accounts with subtype `SUSPENSE` (or the `SUSPENSE`,
`FIXED_ASSET_CLEARING`, `GOODS_RECEIVED_NOT_INVOICED` mappings) are listed with:

- balance (signed by normal side) and the total absolute suspense balance;
- unresolved postings: every ledger line since the balance was last zero;
- age of the oldest unresolved item;
- responsible person (`accounts.owner_user_id`);
- a policy status - `CLEAR`, `WITHIN_POLICY` or `REQUIRES_INVESTIGATION` when the
  balance exceeds `accounting_policies.suspense_materiality` or is older than
  `suspense_max_age_days` (feeds the `SUSPENSE_BALANCE` integrity check, the
  `SUSPENSE_BALANCES` close task and the control dashboard).

Clearing is a `RECLASSIFICATION` journal (the "Clear" button pre-fills one) -
never an edit. The month-end checklist carries a manual "Suspense review" task.

## Reconciliation foundation

Accounts flagged `is_reconciliation` (bank, AR, AP, inventory, tax) are
reconciled in `modules/reconciliation` (recorded reconciliations with
expected-vs-actual balances, exceptions, four-eyes approval and a materiality
threshold) and `modules/banking` (statement matching). Expected balances come
only from `SubledgerBalancesService.compute`, which the integrity checker
shares. Each record tracks reconciled / unreconciled amounts and the
difference.

## Audit trail

`AuditService.record(entry, tx)` writes an immutable `audit_logs` row inside
the business transaction. Accounting actions: `CREATE`, `UPDATE`, `SUBMIT`,
`APPROVE`, `REJECT`, `POST`, `REVERSE`, `CORRECT`, `OPENING_BALANCE`,
`PERIOD_CLOSE`, `PERIOD_SOFT_CLOSE`, `PERIOD_LOCK`, `PERIOD_REOPEN`,
`YEAR_CLOSE`, `ACTIVATE`, `DEACTIVATE`, `RECURRING_RUN`, `PAUSE`, `RESUME`,
`RECOGNIZE`, `CANCEL` on entity types `Account`, `AccountMapping`,
`JournalEntry`, `FiscalPeriod`, `FiscalYear`, `PostingRule`, `DimensionRule`,
`RecurringJournal`, `Prepayment`. The journal detail page shows the history;
`/admin/audit-logs` searches it.

## Segregation of duties and delegation

Document-level SoD uses `sod_policies`: creator != approver
(`journal.create` / `journal.approve`) and approver != poster
(`journal.approve` / `journal.post`); `BLOCK` rejects with `SOD_VIOLATION`,
`WARN` records the warning in the audit trail. Delegated authority
(`modules/delegations`) can lend approval-type permissions only; the
permission guard accepts the delegated permission and `AuthorityService.assert`
enforces scope, amount and SoD per document - a delegation never bypasses SoD
and is never a role. Automated postings (recurring AUTO_POST, scheduled
recognitions) run as the scheduler principal under authority a `journal.post` /
`prepayment.post` holder granted and recorded.
