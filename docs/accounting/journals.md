# Journals

Tables `journal_entries` (header) and `journal_lines`. Source:
`apps/api/src/modules/accounting/journals/`.

## Header

| Column                                                                               | Notes                                                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `company_id`, `branch_id`, `fiscal_period_id`                                        | Tenancy and period (period is re-resolved at posting time)                              |
| `document_number`                                                                    | `JE-<year>-<seq>`, allocated atomically per company / year                              |
| `journal_type`                                                                       | `GENERAL`, `ADJUSTING`, `ACCRUAL`, `RECLASSIFICATION`, `REVERSAL`, `CLOSING`, `OPENING` |
| `status`                                                                             | Lifecycle below                                                                         |
| `entry_date`, `posting_date`, `document_date`                                        | Accounting date (drives the period), date posted, date on the source document           |
| `currency`                                                                           | Always the company base currency - every line is in base                                |
| `transaction_currency`, `exchange_rate`                                              | Set for foreign-currency journals (see [multi-currency.md](multi-currency.md))          |
| `auto_reverse_date`                                                                  | Accruals: the mirror REVERSAL posts on this date when the entry posts                   |
| `total_debit`, `total_credit`                                                        | Document attributes validated against the lines (not a reporting source)                |
| `source_type`, `source_id`, `idempotency_key`                                        | Origin document / replay protection (unique per company)                                |
| `reversal_of_id`, `reversed_by_id`, `correction_of_id`                               | Original / reversal / correction chain                                                  |
| `created_by`, `submitted_by`, `approved_by`, `posted_by`, `rejected_by` + timestamps | Who did what                                                                            |

## Lines

`line_number`, `account_id`, `description`, `debit`, `credit` (base currency),
`branch_id`, `department_id`, `cost_center_id`, `project_id`,
`foreign_debit`, `foreign_credit`, `exchange_rate` (foreign journals only).

DB checks: `debit >= 0 AND credit >= 0`, one side only, never both zero,
foreign amounts follow the same rule; posted headers must have
`total_debit = total_credit`.

## Lifecycle

```
DRAFT -> SUBMITTED -> APPROVED -> POSTED -> LOCKED (period closed)
  ^          |            |          |
  |          v            v          v
  +------ REJECTED <------+       REVERSED (mirror REVERSAL entry posted)
```

| Transition               | Permission        | Rule                                                                           |
| ------------------------ | ----------------- | ------------------------------------------------------------------------------ |
| create / update / delete | `journal.create`  | DRAFT or REJECTED only; balanced; period resolvable (`draft: true`)            |
| submit                   | `journal.submit`  | from DRAFT / REJECTED                                                          |
| approve                  | `journal.approve` | SoD: creator != approver; workflow approval (`ApprovalsService`) if configured |
| reject                   | `journal.approve` | reason required                                                                |
| post                     | `journal.post`    | SoD: approver != poster; delegated to `AccountingPostingService.postEntry`     |
| reverse                  | `journal.reverse` | POSTED / LOCKED; reversal date >= entry date, in an open period                |
| correct                  | `journal.correct` | reverse + pre-filled DRAFT linked as the correction                            |

Every transition writes an immutable audit row (`audit_logs`, action
`CREATE` / `SUBMIT` / `APPROVE` / `REJECT` / `POST` / `REVERSE` / `CORRECT` /
`OPENING_BALANCE`). Posted rows are protected by the
`journal_entries_immutable_when_posted` and `journal_lines_immutable_when_posted`
triggers, so even ad-hoc SQL cannot edit history.

## Journal types

- **GENERAL** - day-to-day entries.
- **ADJUSTING** - period-end adjustments; also used by prepayment recognition
  and depreciation runs.
- **ACCRUAL** - accrued income / expense. Set `autoReverseDate` (typically the
  first day of the next period) and the engine posts the mirror REVERSAL in the
  same transaction as the posting. Recurring templates with `autoReverse`
  default it to the first of the following month.
- **RECLASSIFICATION** - moves a balance between accounts (e.g. clearing
  suspense).
- **REVERSAL** - engine generated; carries `reversal_of_id`.
- **CLOSING** - year-end close (income statement -> retained earnings).
- **OPENING** - opening balances (see below).

## Opening balances

`POST /api/v1/journal-entries/opening-balances` takes per-account balances
(`asOfDate`, `lines[{accountId, debit, credit}]`). If the lines do not balance
the difference is offset against the `OPENING_BALANCE_EQUITY` mapping so the
entry always balances, then it is created as an OPENING **draft** and goes
through submit / approve / post like any other document (SoD applies). An
`OPENING_BALANCE` audit row records the offset. Use it at company creation,
fiscal year initialization and migrations.

## Journal UX

The entry form shows running totals and the state - `Balanced`, `Out of
balance` with the difference, or `Enter amounts` - and disables saving until
debits equal credits. The detail page shows lines, related entries
(original / reversal / correction), foreign amounts, auto-reversal, attachments
and the audit history.

## API

```
GET    /api/v1/journal-entries              paginated, filters: status, journalType, from, to, fiscalPeriodId, accountId, search
GET    /api/v1/journal-entries/:id
POST   /api/v1/journal-entries              idempotent on idempotencyKey
POST   /api/v1/journal-entries/opening-balances
PATCH  /api/v1/journal-entries/:id
DELETE /api/v1/journal-entries/:id
POST   /api/v1/journal-entries/:id/submit | approve | reject | post | reverse | correct
```
