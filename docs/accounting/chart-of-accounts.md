# Chart of accounts

Table `accounts` (one chart per company). Codes are stable identifiers, unique
per company.

| Column               | Meaning                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`               | `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `COST_OF_SALES`, `EXPENSE`, `OTHER_INCOME`, `OTHER_EXPENSE`                                                     |
| `subtype`            | Classification used by reports and controls (`CASH`, `BANK`, `ACCOUNTS_RECEIVABLE`, `PREPAID`, `FIXED_ASSET`, `ACCUMULATED_DEPRECIATION`, `SUSPENSE`, ...) |
| `normal_balance`     | `DEBIT` / `CREDIT`, defaults to the type's natural side (`NORMAL_BALANCE_BY_TYPE`)                                                                         |
| `parent_id`          | Hierarchy; a parent that receives children becomes a header                                                                                                |
| `is_header`          | Header (summary) accounts cannot be posted to (`ACCOUNT_NOT_POSTABLE`)                                                                                     |
| `is_system`          | Required by the engine (retained earnings, opening balance equity); cannot be deactivated                                                                  |
| `is_reconciliation`  | Reconciled against an external source (bank, subledger, authority)                                                                                         |
| `is_intercompany`    | Eliminated in consolidation                                                                                                                                |
| `currency`           | NULL = company base currency; a foreign-currency account only accepts journals in that currency                                                            |
| `cash_flow_activity` | `OPERATING` / `INVESTING` / `FINANCING`; NULL = derived from the subtype                                                                                   |
| `owner_user_id`      | Accountable person (suspense / reconciliation accounts)                                                                                                    |
| `allowed_branch_ids` | Branch applicability: empty = every branch may post; otherwise the engine rejects other branches (`ACCOUNT_BRANCH_NOT_ALLOWED`)                            |
| `status`             | `ACTIVE` / `INACTIVE` - inactive accounts reject postings (`GL_ACCOUNT_INACTIVE`)                                                                          |

Tax configuration lives on tax codes (`modules/tax`), which map to accounts;
the chart itself carries no rates.

## Account types and statements

| Type          | Normal side | Statement                    |
| ------------- | ----------- | ---------------------------- |
| ASSET         | DEBIT       | Balance sheet                |
| LIABILITY     | CREDIT      | Balance sheet                |
| EQUITY        | CREDIT      | Balance sheet                |
| REVENUE       | CREDIT      | P&L - revenue                |
| COST_OF_SALES | DEBIT       | P&L - cost of sales          |
| EXPENSE       | DEBIT       | P&L - operating expenses     |
| OTHER_INCOME  | CREDIT      | P&L - below operating income |
| OTHER_EXPENSE | DEBIT       | P&L - below operating income |

## Hierarchy

`GET /api/v1/accounts` returns the chart as an ordered tree with `level` and
`hasChildren`. A child must have the same type as its parent
(`ACCOUNT_HIERARCHY_INVALID`); an account cannot be moved under its own
descendant; an account with posted activity cannot become a header.

## Mappings

`account_mappings` (`key -> account`) is the configurable layer business
modules use (`ACCOUNTS_RECEIVABLE`, `INVENTORY`, `OUTPUT_VAT`,
`RETAINED_EARNINGS`, `OPENING_BALANCE_EQUITY`, `SUSPENSE`, ...).
`AccountsService.resolveMapped` throws `ACCOUNT_MAPPING_MISSING` instead of
guessing; the integrity checker reports missing required mappings.

## API

```
GET    /api/v1/accounts                 tree (filters: type, status, search, postableOnly)
GET    /api/v1/accounts/:id
POST   /api/v1/accounts                 account.manage
PATCH  /api/v1/accounts/:id             account.manage (status, flags, owner, branch applicability)
DELETE /api/v1/accounts/:id             only without activity
GET    /api/v1/accounts/mappings
PUT    /api/v1/accounts/mappings        account.manage
```

Every change is audited (`Account` / `AccountMapping` entity types).
