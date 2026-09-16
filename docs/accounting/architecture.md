# Accounting core - architecture

Source: `apps/api/src/modules/accounting/`, `apps/api/src/modules/reporting/`.
Companion documents: [../architecture.md](../architecture.md) (platform),
[../accounting-engine.md](../accounting-engine.md) (engine reference),
[../accounting-controls.md](../accounting-controls.md) (controls).

## Flow

```
Business transaction (invoice, bill, payment, depreciation run, manual journal ...)
        |
        v
Domain module  -->  AccountingEvent { companyId, entryDate, lines[], sourceType, sourceId, actor }
        |
        v
AccountingPostingService.postEvent / postEntry      <- the only ledger writer
        |   validates authority, accounts, branches, dimensions, dimension rules,
        |   source document, period state, SUM(debit) = SUM(credit); idempotent
        v
journal_entries + journal_lines (POSTED)             <- immutable (DB triggers)
        |
        v
General ledger read model (GeneralLedgerService.activity / ledger)
        |
        v
Trial balance -> Income statement -> Balance sheet -> Cash flow (ReportingService)
```

The general ledger is the only source of financial truth. Reports are computed
from posted `journal_lines` on demand; no table holds a running total.

## Module layout

| Folder / file                         | Responsibility                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `accounts/`                           | Chart of accounts, hierarchy, account mappings (`resolveMapped`)                                 |
| `fiscal/`                             | Fiscal years / periods, close / soft-close / lock / reopen, year end                             |
| `journals/posting.service.ts`         | **AccountingPostingService** - the posting gateway                                               |
| `journals/journal-entries.service.ts` | Manual journal documents: lifecycle, reversal, correction, opening balances, foreign currency    |
| `journals/fx-lines.logic.ts`          | Pure conversion of foreign-currency lines to base                                                |
| `ledger/`                             | General-ledger read model                                                                        |
| `dimensions/`                         | Departments / cost centers / projects and **dimension rules**                                    |
| `posting-rules/`                      | Declarative Dr / Cr templates per transaction type                                               |
| `recurring/`                          | Recurring journal templates and their runs                                                       |
| `prepayments/`                        | Prepayment schedules and recognition                                                             |
| `suspense/`                           | Suspense account monitor                                                                         |
| `integrity/`                          | Accounting integrity checker                                                                     |
| `accounting-schedules.job.ts`         | Nightly BullMQ job: recurring occurrences + prepayment recognition (`ACCOUNTING_SCHEDULES_CRON`) |
| `../reporting/`                       | Trial balance, P&L, balance sheet, cash-flow statement                                           |

## Tenancy

Organization -> Company -> Branch. Every accounting table carries `company_id`;
the request's `X-Company-Id` header selects the company and every query is
scoped by it. Branches are a line-level dimension; accounts can restrict which
branches may post to them (`accounts.allowed_branch_ids`).

## Money

`NUMERIC(19,4)` in PostgreSQL, decimal strings over the API, `@accounting/money`
(`Money`: add / subtract / multiply / divide / half-even rounding / `allocate` /
`convert`) in code. Never a JavaScript float.

## Rules for every future module

```
Business module -> domain transaction -> AccountingPostingService -> GL
```

- Build an `AccountingEvent`; never insert into `journal_entries` /
  `journal_lines` (DB triggers reject edits to posted rows anyway).
- Resolve accounts with `AccountsService.resolveMapped(companyId, key)` or a
  posting rule (`PostingRulesService.resolve`); never hard-code ids.
- Give every distinct event its own `sourceType` / `sourceId` so replays are
  idempotent; register verifiable source tables in `SOURCE_TABLES`.
- Pass the real actor and the module's posting permission
  (`{ permission: P['bill.post'] }`).
- Run inside the module's own transaction so the business change and the
  ledger write commit together.
