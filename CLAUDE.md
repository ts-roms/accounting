# Project guide for AI-assisted development

Enterprise accounting platform (modular monolith). Read `docs/architecture.md`
and `docs/accounting-engine.md` before changing anything financial.

## Non-negotiables

- The general ledger is the source of truth; never maintain independent totals.
- Money: PostgreSQL `NUMERIC(19,4)`, decimal strings over the API, no JS floats.
- Posted journals are immutable; corrections are reversal/adjusting entries.
- All financial mutations run in one PostgreSQL transaction and write an audit row via `AuditService.record(entry, tx)`.
- Authorization is enforced only in NestJS (`@RequirePermissions(P['x.y'])`); UI checks are cosmetic.
- No hard-coded account ids, tax rates or role names in business logic.
- AI features (Phase 9) are advisory only and never post transactions: `modules/ai` creates drafts through `BillsService` / `ExpenseClaimsService`, answers only from report services, and stores flags/suggestions beside the books. Keep `ai.logic.ts` pure; `AI_PROVIDER=HEURISTIC` must keep working offline (tests rely on it).

## Workflow

- Every ledger write goes through `AccountingPostingService.postEvent/postEntry`; resolve accounts via `AccountsService.resolveMapped`, never by id. Pass the real `actor` and the module's posting `permission` (`{ permission: P['bill.post'] }`); the gateway validates authority, branches, dimensions, source document and period state (`OPEN / SOFT_CLOSED / CLOSED / LOCKED`). Draft-time period checks use `resolvePeriod(..., { draft: true })`. Give every distinct posting event its own source identity - never reuse a parent id for repeated events (see the realized-FX fix).
- Subledger documents keep business status (DRAFT/APPROVED/PARTIALLY_PAID/PAID/VOID) separate from accounting status (UNPOSTED/POSTED/REVERSED); void = reversal journal, never an edit. Allocations never create journal entries.
- Orders (quotation / sales order / purchase request / purchase order) share one `orders` table and `OrdersService`; they never post. Fulfilment counters change only via `OrderFulfillmentService` inside the fulfilling document's transaction.
- Stock only moves through `InventoryService.receive/issue` (movements + FIFO layers + balances); the document that moves it posts the returned cost in the same transaction via `DocumentStockService`. Valuation in `modules/inventory/valuation.ts` is pure - keep it that way.
- Fixed asset cost / accumulated depreciation change only inside `FixedAssetsService` / `DepreciationRunsService` transactions that post the journal; depreciation arithmetic (`modules/fixed-assets/depreciation.ts`) and statement matching (`modules/banking/matching.logic.ts`) are pure - keep them that way. Bank balances are the GL account's balance, never stored.
- Tax is data: never hard-code rates or tax accounts. Documents call `TaxEngineService.applyToLines` when lines change and `postingLines` + `record` when posting (`reverse` on void); tax arithmetic in `modules/tax/tax.logic.ts` stays pure. Dimension references on any line go through `DimensionsService.validateRefs` inside the writing transaction. Budgets never post; variance reads posted journal lines.
- Journal lines are always in the company base currency. Foreign amounts stay on the document; resolve rates only via `ExchangeRatesService.rateFor/documentRate` and convert with `Money.convert`; realized/unrealized FX entries come from `FxService`. Currency schemas that may be omitted use `optionalCurrencyCodeSchema` (`currencyCodeSchema` defaults to PHP).
- Approval gating: documents that can be workflow-gated call `ApprovalsService.open` on submit and `assertApproved` before approve/post; never bypass it per document type.
- Subledger "expected" balances come only from `SubledgerBalancesService.compute` (reconciliation records and the integrity checker share it); never re-derive them elsewhere. Reconciliation approval is four-eyes and blocked by open exceptions / unexplained variance above `accounting_policies.reconciliation_materiality`.
- Attachments are metadata + files under `STORAGE_DIR` via `AttachmentsService`; they never influence posting.
- Receivables and payables screens are one config-driven implementation (`apps/web/lib/subledger/config.ts`, `components/subledger/*`); fix bugs once, not per side.
- Shared packages `types`, `validation`, `config`, `money` are compiled: after editing run `pnpm build:packages` (or keep `pnpm dev` running).
- Schema change: edit `apps/api/src/database/schema/*.ts` -> `pnpm db:generate` -> review SQL -> `pnpm db:migrate`.
- New permission: add to `packages/types/src/permissions.ts` (+ system roles) -> build -> `pnpm db:seed`.
- e2e suites DROP the schema: they only run against a database whose name contains `test` (see `apps/api/test/setup-env.ts`); unit Jest is scoped to `src/`.
- Tests: `pnpm test` (unit), `pnpm --filter @accounting/api test:e2e` (needs Docker infra), `pnpm --filter @accounting/web test:e2e` (needs running stack).
- Lint/typecheck before finishing: `pnpm lint && pnpm typecheck`.

## Conventions

- Errors: throw `AppError` subclasses with codes from `error-codes.ts`; never leak raw DB errors.
- Controllers stay thin; services own transactions and business rules.
- Zod schemas live in `@accounting/validation` and are reused by web forms (`useForm<z.input<S>, unknown, z.output<S>>`).
- Docker PostgreSQL is published on host port 5433 (5432 is often taken locally).
