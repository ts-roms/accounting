# Bank feed auto-reconciliation - architecture

Prompt #12 closes the loop after a bank statement or feed is imported. The
Phase 5 matcher pairs statement lines with ledger lines that already exist;
this prompt explains the rest: **matching rules** (what a line looks like ->
what to post), **document matching** (an open invoice or bill explains the
amount), **history** (lines like this were explained the same way before),
a **review queue** with accept / adjust / dismiss / explain-by-hand, KPIs, a
daily sweep and integrity checks. Everything is company-scoped.

## Module layout (`apps/api/src/modules/bank-feed`)

| File                             | Responsibility                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bank-feed.logic.ts`             | Pure: pattern / rule matching, description normalisation and the 3-word history key, document candidates, `suggestForLine`.                       |
| `bank-feed-rules.service.ts`     | `bank_matching_rules` CRUD + dry-run `test`, `bank_feed_settings`.                                                                                |
| `bank-feed.service.ts`           | `suggest` (engine over unexplained lines, auto-apply per policy), `apply` / `explain` / `dismiss`, review `queue`, `dashboard`, daily `sweepAll`. |
| `bank-feed-integrity.service.ts` | Read-only assertions (see `integrity.md`).                                                                                                        |
| `bank-feed.job.ts`               | `bank-feed-suggestions` daily job (H8 registry).                                                                                                  |
| `bank-feed.controller.ts`        | `/banking/feed/*` (see `docs/api.md`).                                                                                                            |

`BankFeedModule` imports `BankingModule`, `ReceivablesModule` and
`PayablesModule` because applying a suggestion creates and posts documents
through `BankingService.createTransactionInTx / postTransactionInTx`,
`CustomerPaymentsService.createInTx / postInTx` and
`VendorPaymentsService.createInTx / postInTx`. `IntegrationsModule` imports
it so the Plaid / bank-feed importer refreshes suggestions right after
`StatementsService.import`.

## Data

- `bank_matching_rules` - priority, optional bank account, direction
  (`IN` / `OUT` / `ANY`), description and reference patterns (`CONTAINS`,
  `STARTS_WITH`, `REGEX`), absolute amount bounds, the action
  (`POST_TRANSACTION` with transaction type + counterparty account,
  `RECEIVE_CUSTOMER` / `PAY_VENDOR` with the party, `IGNORE`), memo,
  dimensions, `autoApply`, hit count.
- `bank_feed_settings` - `autoApplyRules`, `autoApplyDocumentMatches`,
  `staleAfterDays`, `historyMinOccurrences`.
- `bank_line_suggestions` - per statement line: `source` (`RULE`,
  `DOCUMENT`, `HISTORY`, `MANUAL`), action, rule, confidence (`HIGH` /
  `MEDIUM` / `LOW`), the `payload` (the concrete instruction), explanation,
  status (`PENDING` -> `APPLIED` / `DISMISSED` / `SUPERSEDED`), and once
  applied the result (`BANK_TRANSACTION` / `CUSTOMER_PAYMENT` /
  `VENDOR_PAYMENT` / `IGNORED`, id, number) and the matched journal line.
- `bank_line_matches.kind` gains `RULE` for matches the feed made.

History is **derived, never stored**: matched lines whose journal came from a
bank transaction, customer receipt or vendor payment are grouped by the
history key of their description and direction; the most frequent
explanation per key is what `HISTORY` proposes.

## Engine (`suggestForLine`), best first

1. **Rule** - the first active rule (by priority) whose every condition holds.
   A rule that posts money in never explains money out and vice versa.
   `HIGH` when the rule auto-applies, else `MEDIUM`.
2. **Document** - open invoices for money in, open bills for money out
   (posted, `APPROVED` / `PARTIALLY_PAID`, same currency, bills not on
   hold). Numbers cited in the text whose open balances sum to the amount
   (or one cited number settled partially) -> `HIGH`; a unique open balance
   equal to the amount -> `MEDIUM`, `HIGH` when the party's name is in the
   text. Ambiguous balances produce nothing.
3. **History** - the same history key and direction explained before:
   `MEDIUM` from `historyMinOccurrences`, else `LOW`.

`autoApply` on a draft is true only for rules flagged `autoApply` while
`settings.autoApplyRules` is on, and for `HIGH` full document matches while
`settings.autoApplyDocumentMatches` is on.

## Accounting decisions

- **The feed never writes journals and never matches without a document.**
  Applying posts the explaining document through its owning service inside
  one transaction, then matches the statement line to that document's line
  on the bank's GL account (`bank_line_matches.kind = RULE`, line
  `MATCHED`). `IGNORE` marks the line `DUPLICATE` with an "Ignored" note and
  leaves the ledger alone.
- **Receipts and payments allocate what the suggestion says.** A cited
  invoice / bill is allocated (in full or partially); an amount-only match
  allocates the one document; allocations may never exceed the line amount.
  Anything unallocated stays on account exactly as a manual receipt would.
- **Direction is checked twice** - in the engine and again when applying,
  including overrides (a fee cannot explain money in).
- **Auto-apply needs a person's session.** `suggest` auto-applies only when
  called with an actor (statement import, feed importer, "Refresh
  suggestions"); the daily sweep only suggests and notifies
  (`BANK_FEED_REVIEW`). Rules record their hit count and last hit.
- **Suggestions are rebuilt, not accumulated**: every `suggest` supersedes
  the line's pending non-manual suggestions and inserts the current set.
- **Reconciliation is untouched**: `POSSIBLE_MATCH` / `EXCEPTION` lines keep
  their ledger candidates for the Bank Reconciliation screen; the feed only
  adds document / rule explanations beside them.

## Statement files: MT940, camt.053, OFX / QFX

Besides CSV, the statement importer accepts the exports most banks provide:
SWIFT **MT940** (`:60F:` opening, `:61:` lines with `:86:` narratives, `RC` /
`RD` reversals, `:62F:` closing), ISO 20022 **camt.053** (`OPBD` / `CLBD`
balances, `<Ntry>` entries with remittance info, `RvslInd`) and **OFX / QFX**
(SGML 1.x or XML 2.x, `<STMTTRN>`, `<LEDGERBAL>` as closing, opening derived).
`POST /bank-statements/parse` (multipart, `bank-statement.import`) detects the
format from the content and returns the import shape - account reference,
currency, statement date, opening / closing balance, signed lines and
warnings (a closing balance that disagrees with the lines, entries skipped)

- without storing anything; the import page fills its form from it and the
  same matching engine runs on `POST /bank-statements`. The parsers are pure
  (`modules/banking/statement-formats.logic.ts`, fixed-point decimals, no
  floats) and unit-tested per format. Live API feeds (Plaid) stay connectors in
  the integration platform; a new bank API is one connector class there.

## Web (`apps/web`)

`/banking/feed` (review queue: suggestions with accept / adjust / dismiss,
explain by hand, refresh), `/banking/feed/rules` (rules with a dry-run test,
settings), `/banking/feed/dashboard` (KPIs, ageing, top rules, integrity),
under Finance > Banking.
