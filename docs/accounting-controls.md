# Accounting controls

The rules that make the ledger hard to put into an accounting-invalid state,
where each one is enforced, and how it is verified. Companion to
[accounting-engine.md](accounting-engine.md) (how postings work) and
[permissions.md](permissions.md) (who may do what).

## Defence in depth

| Layer                      | Enforces                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL constraints     | `debit >= 0`, `credit >= 0`, one side per line, non-empty line, header balanced once posted, unique document numbers / idempotency keys / source |
| PostgreSQL triggers        | posted journals immutable (0003); audit rows immutable (0001); nothing enters the ledger in a `LOCKED` period (0011)                             |
| `AccountingPostingService` | every rule in the next section, for every module, inside the caller's transaction                                                                |
| Controllers                | `@RequirePermissions` per route; `@CompanyScoped` company context                                                                                |
| Tests                      | `test/controls.e2e-spec.ts`, `posting.service.spec.ts`, every module suite asserts subledger = control and a balanced trial balance              |
| `IntegrityService`         | the same invariants as read-only checks over live data (`GET /integrity`, Accounting → Integrity)                                                |

## The posting gateway

`AccountingPostingService.postEvent(tx, event, options)` is the only way a
journal reaches the ledger (30 call sites; no module inserts journal rows).
Before it writes anything it validates, in order:

1. **Authority** - `event.actor` must hold `options.permission`
   (`journal.post` by default; subledgers pass their own: `bill.post`,
   `customer-payment.post`, `depreciation.run`, `fixed-asset.post`,
   `inventory.post`, `intercompany.post`, `fx.revalue`, `period.close`, ...).
   The scheduler principal is marked `system` and is gated by configuration.
2. **Idempotency** - an existing entry with the same `(company, idempotencyKey)`
   or `(company, sourceType, sourceId)` is returned instead of re-posted; both
   pairs are unique indexes, so concurrent posts of one document produce one
   journal (the loser of the race hits the index or the row lock).
3. **Lines** - accounts exist in the company, are postable (not header),
   active, in the journal currency; amounts non-negative, one side per line,
   non-zero; `SUM(debit) = SUM(credit)` with exact decimals.
4. **Branches** - header / line branches belong to the company and are active.
5. **Dimensions** - department / cost center / project references are valid
   for the company and effective on the entry date (`DimensionsService`).
6. **Source document** - for every source type the gateway knows
   (`SOURCE_TABLES`), the row must exist in the company.
7. **Fiscal period** - see the state table below.

Then it allocates the number, writes header and lines, audits `POST` with
`{ periodStatus, authority, system }` in the metadata and emits
`accounting.journal.posted`.

## Fiscal period states

| State         | Drafting | Posting                                                    | Leaves via                                                |
| ------------- | -------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `OPEN`        | yes      | yes                                                        | soft-close, close                                         |
| `SOFT_CLOSED` | yes      | only `period.post-soft-closed` holders and system postings | reopen (reason required), close                           |
| `CLOSED`      | no       | only the year-end closing routine                          | reopen (`period.reopen`, reason ≥ 5 chars, audited), lock |
| `LOCKED`      | no       | nobody - service _and_ database trigger                    | never                                                     |

Closing requires every earlier period closed or locked and no unposted
entries in the period; closing marks its posted entries `LOCKED`. Reopening
requires no later period closed or locked, stores `reopen_reason`, and returns
the entries to `POSTED`. Every transition writes an audit row
(`PERIOD_SOFT_CLOSE`, `PERIOD_CLOSE`, `PERIOD_REOPEN`, `PERIOD_LOCK`).

## Reversals and corrections

Posted entries are never edited. Two controlled paths exist:

- **Reverse** (`journal.reverse`) - a mirror-image `REVERSAL` entry is posted;
  the original becomes `REVERSED` and both stay in the ledger, linked through
  `reversal_of_id` / `reversed_by_id`.
- **Correct** (`journal.correct`) - the original is reversed as above and a
  `DRAFT` `ADJUSTING` entry pre-filled with the original lines is created
  with `correction_of_id` pointing at the original. The draft goes through the
  normal submit → approve → post workflow. `related[]` on every entry lists
  the chain (original, reversal, correction) for navigation; the audit trail
  carries `REVERSE` and `CORRECT` with the reason.

Year-end `CLOSING` entries cannot be corrected; reopen the year instead.

## Invariants

Executable in `IntegrityService` (severity in brackets) and asserted by the
test suites after every scenario:

- Every ledger entry balances on its lines and its header [CRITICAL]
- Every entry sits in the fiscal period covering its date [CRITICAL]
- Nothing is posted after its period closed, except the closing routine [CRITICAL]
- Ledger lines reference postable accounts of the company [CRITICAL]
- No orphan lines [CRITICAL]
- The period-balance read model equals the posted lines for every
  (account, month, journal type, dimension set) key [CRITICAL]
- Required account mappings resolve to postable accounts [CRITICAL]
- AR subledger = AR control; AP subledger = AP control [CRITICAL]
- Tax register = document-driven movements on tax accounts [CRITICAL]
- Inventory valuation = inventory accounts [CRITICAL]
- Fixed asset register (cost, accumulated) = asset accounts, including the
  mapped accounts when no asset is registered [CRITICAL]
- No vendor invoice number billed twice; no identical vendor payment on one day [WARNING]
- No negative stock where the company forbids it [WARNING]

The checker found two seed violations when first run (equipment billed
straight to the asset cost account; a manual depreciation journal); both were
corrected so the sample company reconciles from day one.

## Known limitations (next phases)

- Excel imports, invoice / bill imports and department-scoped numbering are not implemented (see `docs/data-infrastructure.md`).

- Close checklists have no due dates or reminders, and the template is fixed in code (see `docs/financial-close.md`).
- Department-specific approval rules, a responsible owner per suspense account and failed-job tracking are still open (see `docs/enterprise-controls.md`).
