# Project guide for AI-assisted development

Enterprise accounting platform (modular monolith). Read `docs/architecture.md`,
`docs/accounting-engine.md` and `docs/accounting/*.md` before changing anything financial.

## Non-negotiables

- The general ledger is the source of truth; never maintain independent totals.
- Money: PostgreSQL `NUMERIC(19,4)`, decimal strings over the API, no JS floats.
- Posted journals are immutable; corrections are reversal/adjusting entries.
- All financial mutations run in one PostgreSQL transaction and write an audit row via `AuditService.record(entry, tx)`.
- Authorization is enforced only in NestJS (`@RequirePermissions(P['x.y'])`); UI checks are cosmetic.
- No hard-coded account ids, tax rates or role names in business logic.
- AI features (Phase 9) are advisory only and never post transactions: `modules/ai` creates drafts through `BillsService` / `ExpenseClaimsService`, answers only from report services, and stores flags/suggestions beside the books. Keep `ai.logic.ts` pure; `AI_PROVIDER=HEURISTIC` must keep working offline (tests rely on it).

## Workflow

- Every ledger write goes through `AccountingPostingService.postEvent/postEntry` (reversals through `reverseEntry`); resolve accounts via `AccountsService.resolveMapped` or `PostingRulesService.resolve`, never by id. The gateway also enforces dimension rules (`DimensionRulesService`) and account branch applicability; keep `dimension-rules.logic.ts`, `posting-rules.logic.ts`, `fx-lines.logic.ts`, `recurring.logic.ts`, `prepayments.logic.ts` and `reporting/cash-flow.logic.ts` pure. Pass the real `actor` and the module's posting `permission` (`{ permission: P['bill.post'] }`); the gateway validates authority, branches, dimensions, source document and period state (`OPEN / SOFT_CLOSED / CLOSED / LOCKED`). Draft-time period checks use `resolvePeriod(..., { draft: true })`. Give every distinct posting event its own source identity - never reuse a parent id for repeated events (see the realized-FX fix).
- Accruals set `autoReverseDate`: the engine posts the mirror REVERSAL in the same transaction. Recurring journals (`recurring_journal_runs`) and prepayment instalments (`prepayment_schedules`) are the source identity of the journals they generate; AUTO_POST templates and prepayment activation / recognition are posting decisions (`journal.post` / `prepayment.post`). Opening balances are OPENING drafts offset to `OPENING_BALANCE_EQUITY`.
- Subledger documents keep business status (DRAFT/APPROVED/PARTIALLY_PAID/PAID/VOID) separate from accounting status (UNPOSTED/POSTED/REVERSED); void = reversal journal, never an edit. Allocations never create journal entries.
- Orders (quotation / sales order / purchase request / purchase order) share one `orders` table and `OrdersService`; they never post. Fulfilment counters change only via `OrderFulfillmentService` inside the fulfilling document's transaction.
- Stock only moves through `InventoryService.receive/issue` (movements + FIFO layers + balances); the document that moves it posts the returned cost in the same transaction via `DocumentStockService`. Valuation in `modules/inventory/valuation.ts` is pure - keep it that way.
- Fixed asset cost / accumulated depreciation change only inside `FixedAssetsService` / `DepreciationRunsService` transactions that post the journal; depreciation arithmetic (`modules/fixed-assets/depreciation.ts`) and statement matching (`modules/banking/matching.logic.ts`) are pure - keep them that way. Bank balances are the GL account's balance, never stored.
- Tax is data: never hard-code rates or tax accounts. Documents call `TaxEngineService.applyToLines` when lines change and `postingLines` + `record` when posting (`reverse` on void); tax arithmetic in `modules/tax/tax.logic.ts` stays pure. Dimension references on any line go through `DimensionsService.validateRefs` inside the writing transaction. Budgets never post; variance reads posted journal lines.
- Journal lines are always in the company base currency. Foreign amounts stay on the document; resolve rates only via `ExchangeRatesService.rateFor/documentRate` and convert with `Money.convert`; realized/unrealized FX entries come from `FxService`. Currency schemas that may be omitted use `optionalCurrencyCodeSchema` (`currencyCodeSchema` defaults to PHP).
- Approval gating: documents that can be workflow-gated call `ApprovalsService.open` on submit and `assertApproved` before approve/post; never bypass it per document type.
- Subledger "expected" balances come only from `SubledgerBalancesService.compute` (reconciliation records and the integrity checker share it); never re-derive them elsewhere. Reconciliation approval is four-eyes and blocked by open exceptions / unexplained variance above `accounting_policies.reconciliation_materiality`.
- Attachments are metadata + files under `STORAGE_DIR` via `AttachmentsService`; they never influence posting.
- Integrations (`modules/integrations`, docs in `docs/integrations/`) are adapters: connectors return external records, importers validate with the API's Zod schemas and call the domain services (`CustomersService`, `InvoicesService`, `CustomerPaymentsService`, `StatementsService`); nothing in the platform writes journal rows. Posting needs an explicit `:post` scope. Provider credentials go through `CredentialsService` (encrypted) and are never returned or logged; mapping / retry / signature / health logic stays pure. New provider = one connector class + `connectors/index.ts`.
- Domain events for webhooks are written with `OutboxService.enqueue(tx, ...)` inside the business transaction (global module); never emit outbound webhooks directly.
- Delegated authority (`modules/delegations`): approval-type permissions only (`DELEGABLE_PERMISSIONS`). Every approve-type service calls `AuthorityService.assert(tx, actor, permission, doc)` after loading the document; the guard accepts a delegated permission, the service enforces scope / amount / SoD and records usage. Never treat a delegation as a role.
- Financial close (`modules/financial-close`) is the only UI path that closes a period: automatic checklist tasks are evaluated from ledger data and never ticked by hand; policy flags in `accounting_policies` decide which failures block. Completion calls `FiscalPeriodsService` inside the same transaction.
- Enterprise controls (H5): document-level SoD goes through `SodService.checkActorSeparation` with the document ref (WARN is audited); workflow gating with `assertApproved` opens the request on its own connection because the caller rolls back; `UPDATE` audit events with `previousValue` + `newValue` objects produce `field_changes` rows automatically (pass `metadata.reason`); suspense figures come only from `SuspenseService.monitor`; the control dashboard (`modules/controls`) composes other services and stores nothing.
- Receivables and payables screens are one config-driven implementation (`apps/web/lib/subledger/config.ts`, `components/subledger/*`); fix bugs once, not per side.
- UI: one design system (`docs/design-system/`). Tokens live only in `packages/ui/src/styles.css` (+ `packages/ui/src/theme`); modules use semantic utilities (`text-positive`, `bg-card`, `duration-fast`, `type-label`), never raw colours or durations. Status = `StatusBadge` / `components/status` (icon + text, never colour alone); money = `Amount` / `CurrencyDisplay`; posting & approving = `OperationDialog`; lifecycles = `StepTimeline`; loading/empty/error = shared skeletons, `EmptyState`, `ErrorState`. Motion is CSS + `@accounting/ui` helpers (no animation library) and must honour reduced motion.
- Shared packages `types`, `validation`, `config`, `money` are compiled: after editing run `pnpm build:packages` (or keep `pnpm dev` running).
- Schema change: edit `apps/api/src/database/schema/*.ts` -> `pnpm db:generate` -> review SQL -> `pnpm db:migrate`.
- New permission: add to `packages/types/src/permissions.ts` (+ system roles) -> build -> `pnpm db:seed`.
- e2e suites DROP the schema: they only run against a database whose name contains `test` (see `apps/api/test/setup-env.ts`); unit Jest is scoped to `src/`. Each git worktree gets its own test database automatically (`accounting_test_<worktree>`, created by `test/global-setup.ts`); set `TEST_DATABASE_SUFFIX` to isolate another checkout or session - never run two e2e suites against one database.
- Tests: `pnpm test` (unit), `pnpm --filter @accounting/api test:e2e` (needs Docker infra), `pnpm --filter @accounting/web test:e2e` (needs running stack).
- Lint/typecheck before finishing: `pnpm lint && pnpm typecheck`.

## Conventions

- Errors: throw `AppError` subclasses with codes from `error-codes.ts`; never leak raw DB errors.
- Controllers stay thin; services own transactions and business rules.
- Zod schemas live in `@accounting/validation` and are reused by web forms (`useForm<z.input<S>, unknown, z.output<S>>`).
- Docker PostgreSQL is published on host port 5433 (5432 is often taken locally).
