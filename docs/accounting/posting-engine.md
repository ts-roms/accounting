# Posting engine - AccountingPostingService

Source: `apps/api/src/modules/accounting/journals/posting.service.ts`. This is
the **only supported mechanism** for writing to the general ledger. Receivables,
payables, inventory, banking, fixed assets, tax, FX, expense claims, recurring
journals, prepayments and manual journals all post through it.

## API

```ts
postEvent(tx, event: AccountingEvent, opts?)   // create + post in one step
postEntry(tx, entryId, actor, opts?)           // post an APPROVED document
reverseEntry(tx, entry, { reversalDate, description?, actor, permission? })
validateLines(tx, companyId, currency, lines)  // exact-decimal validation
resolvePeriod(tx, companyId, entryDate, opts?, actor?)
assertAccountBranches(accountsById, headerBranchId, lines)
```

```ts
interface AccountingEvent {
  companyId: string;
  entryDate: string;
  description: string;
  reference?: string | null;
  journalType?: JournalType;
  branchId?: string | null;
  lines: PostingLine[]; // { accountId, debit, credit, description?, branchId?, departmentId?, costCenterId?, projectId?, foreignDebit?, foreignCredit?, exchangeRate? }
  sourceType?: string | null; // e.g. AR_DOCUMENT
  sourceId?: string | null; // the document id
  idempotencyKey?: string | null;
  reversalOfId?: string | null;
  documentDate?: string | null;
  transactionCurrency?: string | null; // amounts are already base
  exchangeRate?: string | null;
  autoReverseDate?: string | null;
  actor: PostingActor; // { id, permissions, system? }
}
```

The service never opens its own transaction: the caller's transaction carries
the business change and the ledger write, so both commit or roll back together.

## What a posting validates

| Step            | Check                                                                                                                                   | Error                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Authority       | actor holds `opts.permission` (default `journal.post`) or is the scheduler principal                                                    | `PERMISSION_DENIED`                                                                                           |
| Idempotency     | existing entry for `(company, idempotencyKey)` or `(company, sourceType, sourceId)` -> returned as-is                                   | -                                                                                                             |
| Lines           | >= 2 lines; accounts exist in the company, active, not header, currency matches; amounts non-negative, one side per line, not both zero | `JOURNAL_UNBALANCED`, `ACCOUNT_NOT_POSTABLE`, `GL_ACCOUNT_INACTIVE`, `CURRENCY_MISMATCH`, `VALIDATION_FAILED` |
| Balance         | `SUM(debit) = SUM(credit)` with exact decimals                                                                                          | `JOURNAL_UNBALANCED`                                                                                          |
| Branches        | header / line branches belong to the company and are active; branch-restricted accounts respected                                       | `NOT_FOUND`, `ACCOUNT_BRANCH_NOT_ALLOWED`                                                                     |
| Dimensions      | references exist, are active, of the right type and open on the date                                                                    | `NOT_FOUND`, `VALIDATION_FAILED`                                                                              |
| Dimension rules | every rule matching the line's account is satisfied                                                                                     | `DIMENSION_REQUIRED`                                                                                          |
| Source          | a known `sourceType` must point at a row of the company                                                                                 | `SOURCE_DOCUMENT_INVALID`                                                                                     |
| Period          | `OPEN` always; `SOFT_CLOSED` with `period.post-soft-closed`; `CLOSED` only for the year-end routine; `LOCKED` never                     | `ACCOUNTING_PERIOD_*`                                                                                         |

Then, in the same transaction: the header gets `POSTED`, `posting_date`,
`posted_by/at`; an audit row (`POST`) is written; an outbox event
(`journal.posted` / `journal.reversed`) is enqueued; the in-process
`accounting.journal.posted` event is emitted; and, when `auto_reverse_date` is
set, the mirror REVERSAL is posted through `reverseEntry`.

## Idempotency

- `journal_entries_idempotency_uq (company_id, idempotency_key)`
- `journal_entries_source_uq (company_id, source_type, source_id)`

A repeated `postEvent` returns the existing entry; a repeated `postEntry` on a
posted entry is a no-op. Reversals use `JOURNAL_REVERSAL` + the original id, so
an entry can only ever be reversed once. Recurring occurrences use the run row
id, prepayment instalments the schedule row id.

## Concurrency

- `postEntry` locks the header `FOR UPDATE`; two concurrent posts serialize and
  the second sees `POSTED` and returns.
- Document numbers are allocated with an atomic upsert on `document_sequences`.
- Period close takes the period row lock and refuses while unposted documents
  exist; a posting that loses the race sees `CLOSED` in `resolvePeriod`.
- Recurring runs insert the `(template, run_date)` row first; a second worker
  hits the unique index and rolls back before any journal is written.

Verified by `apps/api/test/controls.e2e-spec.ts` (concurrent posts, replayed
idempotency keys) and `accounting-core.e2e-spec.ts` (repeated runs /
recognitions).

## Reversals

`reverseEntry` posts the mirror image (debits <-> credits, foreign amounts
mirrored, dimensions kept) as a `REVERSAL` dated on `reversalDate`, marks the
original `REVERSED` (it stays in the ledger) and audits it. Manual reversals,
corrections (`journal.correct`), auto-reversing accruals and prepayment
cancellations all use it. See [reversals.md](reversals.md).

## Integration example

```ts
await this.db.transaction(async (tx) => {
  // ... update the bill ...
  const ar = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_PAYABLE', tx);
  await this.posting.postEvent(
    tx,
    {
      companyId,
      entryDate: bill.billDate,
      description: `Bill ${bill.documentNumber}`,
      lines: [...],
      sourceType: 'AP_DOCUMENT',
      sourceId: bill.id,
      actor: { id: user.id, permissions: user.permissions },
    },
    { permission: P['bill.post'] },
  );
});
```

Or, with a posting rule (see [posting-rules.md](posting-rules.md)):

```ts
const rule = await this.postingRules.resolve(tx, companyId, 'VENDOR_BILL', {
  amounts: { NET: '100', TAX: '12', GROSS: '112' },
  accounts: { EXPENSE: line.accountId },
});
await this.posting.postEvent(tx, { ..., journalType: rule.journalType, lines: rule.lines, actor });
```
