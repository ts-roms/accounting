# General ledger

Source: `apps/api/src/modules/accounting/ledger/general-ledger.service.ts`.

The ledger is a **read model over posted journal lines** (statuses `POSTED`,
`LOCKED`, `REVERSED`). Nothing is cached or maintained separately; every
report starts from `activity()`.

```ts
activity(filter); // debit / credit totals per account for a window (branch, dimension, type, journal-type filters)
ledger(companyId, query); // one account: opening balance, lines with running balance, closing balance
currency(companyId);
```

## `GET /api/v1/general-ledger`

Query: `accountId`, `from`, `to`, `branchId`, `departmentId`, `costCenterId`,
`projectId`, `page`, `pageSize`.

Response: account header, `openingBalance` (signed by the account's normal
side, all activity before `from`), paginated lines - date, document number,
journal type, description, reference, `sourceType` / `sourceId`, debit, credit,
running balance - and `closingBalance`.

## Drill-down

```
Financial statement row  -> drill { accountId, from, to }
        -> /accounting/general-ledger?accountId=...&from=...&to=...
        -> ledger line -> /accounting/journal-entries/:id
        -> journal header sourceType / sourceId -> source document (invoice, bill, payment, asset ...)
```

Every statement row (P&L, balance sheet, cash flow, trial balance) carries a
`drill` descriptor the UI turns into a ledger query; ledger lines link to the
journal, and the journal links to its source document.

## Indexes

`journal_lines (company_id, account_id)`, `(journal_entry_id)`, per dimension
`(company_id, department_id | cost_center_id | project_id)`;
`journal_entries (company_id, entry_date)`, `(fiscal_period_id)`,
`(company_id, status)`, `(company_id, source_type)`, unique
`(company_id, source_type, source_id)`, unique `(company_id, idempotency_key)`.
