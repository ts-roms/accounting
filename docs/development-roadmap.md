# Development Roadmap

Rule for every phase: design database -> domain model -> backend -> tests ->
API -> frontend -> end-to-end test -> verify accounting effects -> docs. A
phase does not start until the accounting behaviour of the previous one is
reliable and covered by automated tests.

## Phase 1 - Foundation (COMPLETE)

- pnpm + Turborepo monorepo; Next.js 15, NestJS 11, TypeScript 5.9
- PostgreSQL 16 + Drizzle (migrations, CHECK/UNIQUE constraints), Redis + BullMQ
- Docker Compose (infra + app profile), multi-stage Dockerfiles
- Environment validation, structured logging, correlation ids, health checks
- Authentication: Argon2id, JWT access + rotating refresh sessions, lockout,
  CSRF header, rate limiting
- Organizations / companies / branches
- Users, roles, fine-grained permissions, company-scoped assignments,
  segregation-of-duties policies (WARN/BLOCK), last-super-admin invariant
- Append-only audit trail (DB trigger) written inside business transactions
- Web shell: sidebar navigation, command menu, company switcher, data tables,
  admin pages (users, roles/permissions, audit logs, organization)
- Tests: API unit (14), API integration against PostgreSQL (14), web unit (7),
  Playwright e2e (3)

## Phase 2 - Accounting Core (COMPLETE)

- `@accounting/money`: exact-decimal Money value object + display formatting
- Chart of accounts (hierarchy, types/subtypes, normal balance, header/system
  flags, deactivate-not-delete) and configurable account mappings
- Fiscal years/periods: generation, sequential close/reopen with audit,
  year-end close with automatic CLOSING entry to retained earnings
- Journal entries: DRAFT -> SUBMITTED -> APPROVED -> POSTED -> LOCKED,
  REJECTED, REVERSED; document numbering `JE-YYYY-NNNNNN`; idempotency keys;
  document-level segregation of duties
- `AccountingPostingService` (single write path to the ledger), posted-journal
  immutability enforced by database triggers, `journal.posted` domain event
- General ledger (running balances), trial balance, income statement,
  balance sheet with drill-down descriptors
- Web: chart of accounts + mappings, journal list/editor/detail with workflow
  actions, general ledger, trial balance, period closing, financial
  statements; dashboard KPIs sourced from the ledger
- Tests: API unit (23), API integration (32 incl. 18 accounting invariants),
  web unit (7), Playwright e2e (6)

## Phase 3 - AR / AP (COMPLETE)

- Customers and vendors (payment terms, credit limit, default revenue/expense
  account, deactivate-not-delete) with live balances (outstanding, overdue,
  unapplied credit)
- Invoices, credit notes and debit notes (AR) / bills and vendor credit and
  debit notes (AP): line items with quantity x unit price computed in exact
  decimals, DRAFT -> APPROVED -> PARTIALLY_PAID -> PAID / VOID business status
  kept separate from UNPOSTED / POSTED / REVERSED accounting status
- Posting through `AccountingPostingService` against the
  `ACCOUNTS_RECEIVABLE` / `ACCOUNTS_PAYABLE` mappings; voiding a posted
  document reverses it - nothing is ever edited or deleted after posting
- Customer receipts / vendor payments and refunds with allocations applied at
  post time, on-account (unapplied) balances, later allocation, voiding that
  releases allocations; credit notes applied to open documents with no ledger
  effect
- Credit-limit warnings (exposure includes unposted documents), AP duplicate
  detection (vendor invoice number unique per vendor; same amount within 7
  days flagged), promised-payment / scheduled-payment follow-up
- Reports: AR/AP aging (as-of aware), customer/vendor statements, subledger
  vs. control account reconciliation, AP payment schedule
- Web: config-driven receivables/payables screens (parties, documents with
  line editor, payments with allocation editor, aging + reconciliation),
  dashboard AR/AP/overdue KPIs from the aging report
- Tests: API unit (29), API integration (45 incl. 13 subledger scenarios),
  web unit (7), Playwright e2e (8)

## Phase 4 - Sales & Purchasing (COMPLETE)

- One `orders` engine for quotations, sales orders, purchase requests and
  purchase orders: type-specific lifecycles (send/accept/convert,
  submit/approve/reject/convert, approve/close/cancel), discounted lines with
  exact-decimal totals, document-level segregation of duties on approval
- Conversions keep the chain: quotation -> sales order, purchase request ->
  purchase order (source and converted numbers on both sides)
- Fulfilment counters on order lines (received / billed or invoiced / returned)
  maintained in the same transaction as the fulfilling document; over-fulfilment
  rejected; orders auto-close when fully fulfilled and reopen on void
- Invoicing a sales order / billing a purchase order raises a draft AR / AP
  document through the Phase 3 services - the only place a ledger effect happens
- Goods receipts (draft -> confirmed -> cancelled) update received quantities;
  no ledger effect until inventory valuation (Phase 5)
- Three-way matching on vendor bills: quantity, price, missing receipt, missing
  purchase order, duplicate invoice - tolerances and rules are per-company
  configuration; unreviewed exceptions put the bill on payment hold until an
  approver reviews them (audited)
- Sales and purchase returns: approved, then credited through an AR / AP credit
  note at the order's net prices; capped by invoiced / received quantities
- Web: config-driven order screens (list, form with discount column, detail with
  convert / invoice / bill / receive / return dialogs), goods receipts, returns,
  purchasing settings, three-way match card on bills
- Tests: API unit (34), API integration (56 incl. 11 order scenarios), web unit
  (7), Playwright e2e (11)

## Phase 5 - Inventory (COMPLETE)

- Products (goods / services, lot or serial tracking, per-product costing
  method, reorder levels, GL overrides), categories, warehouses with locations,
  per-company inventory settings (default costing, negative stock rule)
- Inventory engine: append-only movements, FIFO cost layers, balances per
  product / warehouse / lot, lots and serial numbers; every quantity change
  returns its exact cost so the ledger effect posts in the same transaction
- Valuation: FIFO and weighted average as pure, deterministic functions over
  exact decimals; emptying a balance relieves its exact value
- Accounting integration: goods receipt Dr inventory / Cr GRNI; PO-matched
  bill Dr GRNI / Cr AP with price variance to PPV; direct purchase Dr inventory;
  invoice Dr COGS / Cr inventory in the same entry as the sale; credit notes,
  voids and receipt cancellations move stock back at the original value
- Stock documents: adjustments (in / out with reason), transfers (no journal),
  counts (system snapshot vs. counted, variance posted); drafts move nothing
- Reports: stock on hand (with reorder flags), stock card, inventory valuation
  = subledger vs. inventory control account(s), value by warehouse
- Web: products / categories / warehouses, stock on hand, adjustment /
  transfer / count screens, valuation, settings; product + warehouse (+ lot /
  serials) pickers on order and document lines
- Tests: API unit (37), API integration (68 incl. 12 inventory scenarios), web
  unit (7), Playwright e2e (13)

## Phase 6 - Fixed Assets & Banking (COMPLETE)

- Asset categories (default life, method, GL overrides) and an asset register:
  draft -> capitalised (Dr asset cost / Cr clearing or chosen account) ->
  depreciating -> fully depreciated / disposed / written off; transfers,
  impairment (Dr impairment loss / Cr accumulated), upward revaluation (Dr cost
  / Cr revaluation surplus), disposal (release cost and accumulated, proceeds,
  gain or loss); every event keeps its journal, cost fields lock once posted
- Depreciation: pure straight-line / declining-balance arithmetic (final month
  absorbs rounding), one run per fiscal period posted in period order as a
  single ADJUSTING journal aggregated per expense / accumulated pair, preview,
  reversal of the latest run only, monthly BullMQ job (draft or auto-post per
  company setting) acting as the seeded system scheduler user
- Bank accounts bound to one postable CASH / BANK GL account; balance is the
  ledger balance. Bank transactions (deposit, withdrawal, fee, interest,
  transfer) draft -> posted -> void by reversal
- Statements: import (opening + lines = closing enforced), pure matching engine
  (same signed amount within a date tolerance, reference breaks ties; ambiguous
  -> exception; repeated line -> duplicate; each ledger line consumed once),
  manual match / unmatch / ignore, record a missing item straight from the
  line (auto-matched on posting), re-run matching
- Reconciliation: statement + deposits in transit - outstanding payments =
  ledger + unrecorded credits - unrecorded debits; completion requires zero
  difference and every line explained, freezes the statement and the
  transactions behind it; voided pairs are excluded from reconciling items
- Web: asset register / detail with lifecycle dialogs and schedule, categories,
  depreciation runs with preview and scheduler setting, bank accounts and
  matching settings, transactions, statement import (CSV / TSV paste or file)
  and a reconciliation workspace with a candidate picker
- Tests: API unit (44), API integration (78 incl. 10 asset / banking
  scenarios), web unit (7), Playwright e2e (15)

## Phase 7 - Budgeting, Cost Accounting & Tax (COMPLETE)

- Cost dimensions (department, cost center, project) as typed references on
  journal lines, invoice / bill lines, budget lines and expense claim lines;
  validated inside every writing transaction; general ledger, trial balance
  and income statement filter by them
- Tax engine: tax codes are data (kind sales-tax / withholding, side, reporting
  category, per-side accounts, defaults) with effective-dated rates; per-line
  sales tax and withholding on invoices and bills (total = subtotal + tax -
  withholding), balancing tax lines aggregated per account, append-only
  `tax_transactions` (reversals insert negated rows); tax-inclusive split for
  expense claims; summary (output - input = net payable) and withholding by
  counterparty reports
- Budgets per fiscal year with versions (draft grid -> approved, superseded on
  re-approval); variance = posted actuals per account and period in the
  account's natural direction against the approved version, filterable by
  dimension
- Expense claims: draft -> submitted -> approved (never by the claimant; SoD
  policy) -> posted (Dr expense net of tax / Dr input tax / Cr due to
  employees) -> paid (Dr due to employees / Cr bank), with reject and cancel
- Web: dimensions, tax codes with rate history, tax transactions and reports,
  budgets with a grid editor and versions, variance analysis, expense claims;
  tax and dimension cells on document and journal lines
- Tests: API unit (47), API integration (87 incl. 9 Phase 7 scenarios), web
  unit (7), Playwright e2e (17)

## Phase 8 - Advanced Enterprise (COMPLETE)

- Multi-currency: organization-wide exchange rates (NUMERIC(19,8), latest
  quote on or before the date, reverse pairs inverted, per-document override);
  customers / vendors carry a currency; invoices, bills and payments convert to
  base at posting, realized FX gain / loss on settlement, later allocations and
  credit-note applications, all reversed by voids; period-end revaluation of
  open foreign items as an ADJUSTING entry with an automatic next-day reversal;
  AR / AP reconciliation and aging in base currency
- Intercompany transactions mirrored in both companies' ledgers (due from /
  due to affiliates) with reversal; consolidated trial balance translated at
  the closing rate with intercompany eliminations and a zero-net check
- Approval workflows as data: amount bands per document type, ordered steps
  with a required permission and approver count, four-eyes rules; journals,
  expense claims, purchase orders and vendor payments are gated
  (`APPROVAL_REQUIRED`) until the request is approved; inbox of decidable steps
- Attachments on journals, documents, payments and claims (disk storage,
  sha256, MIME allow-list, 15 MB)
- Web: exchange rates, FX revaluation, intercompany, consolidation report,
  workflows, approvals inbox, attachment panels; currency and rate fields on
  party, document and payment forms
- Tests: API unit (50), API integration (97 incl. 10 Phase 8 scenarios), web
  unit (7), Playwright e2e (20)

## Phase 9 - AI (advisory only) (COMPLETE)

- Document intake: PDFs, images and text files are stored as attachments,
  read (text layer / `pdf-parse`, or the model backend for images), and turned
  into extracted header fields and lines with a confidence score; vendors are
  matched by TIN or name; a reviewer corrects the fields, then the intake
  creates a DRAFT bill or expense claim through the ordinary services (their
  permissions, numbering, tax and approval rules apply) and moves the source
  file onto it - nothing is ever posted by the intake
- Account classification: suggestions from the company's own posting history
  (token overlap + same-party usage, with the usual tax code), surfaced as a
  per-line "suggest" button on invoice / bill forms and as pre-filled hints on
  intake lines; a party-only guess yields to the vendor's default account
- Anomaly detection: pure detectors over posted data (duplicate documents,
  amounts unusual for the party, large round figures, weekend postings,
  backdated manual entries, manual journals on control accounts, one person
  handling several lifecycle steps) with severity and a stable fingerprint;
  on-demand scans plus a nightly BullMQ scan; reviewers confirm or dismiss
- Assistant: question parsing (intent + period phrases) answered from the same
  report services the UI uses, filtered by the asker's permissions, every
  answer citing its sources; conversations are stored per user; a model
  backend may phrase the answer but cannot add numbers
- Forecast: monthly posted activity for revenue, expenses, net income or net
  cash movement projected by a least-squares trend (seasonal index with two
  full years) with a one-sigma band and the fit reported
- Provider abstraction: `HEURISTIC` (deterministic, offline, used in tests)
  or `ANTHROPIC` (Claude via the Messages API for extraction / phrasing);
  outputs always pass the same Zod schemas as human input
- Web: intake tray and review page, anomaly workspace, assistant chat,
  forecast page with an inline chart; "AI Assistant" navigation group
- Tests: API unit (62 incl. 12 AI logic), API integration (104 incl. 7 AI
  scenarios), web unit (7), Playwright e2e (23)

## Hardening - enterprise controls (in progress)

A second programme strengthens the delivered system along the lines of
[accounting-controls.md](accounting-controls.md); phases run in risk order.

### H1 - Accounting integrity (COMPLETE)

- Posting gateway validates actor authority (per-module posting permission,
  system principal for the scheduler), branches, dimensions and the source
  document before any write; period state enforced per posting
- Fiscal period states OPEN / SOFT_CLOSED / CLOSED / LOCKED with soft-close,
  lock and reason-mandatory reopen; database trigger makes LOCKED absolute
- Correction workflow: reversal + linked correcting draft, chain navigable
- Realized-FX identity bug fixed (one journal per settlement event; two
  allocations of one foreign payment no longer collapse into one)
- Integrity checker (13 invariants) as `GET /integrity` and the Accounting →
  Integrity dashboard; it found and fixed two seed violations
- Tests: API unit 62 (+4), API integration 110 (+6 controls), Playwright 26 (+3)

### H2 - Subledgers (COMPLETE)

- `SubledgerBalancesService`: one implementation of every subledger's expected
  balance (AR, AP, inventory, fixed assets, tax); the integrity checker and the
  recorded reconciliations share it
- Tax reconciliation: signed tax register per tax account against
  document-driven ledger movements; fixed-asset reconciliation always compares
  the mapped accounts
- Recorded reconciliations with lifecycle (IN_PROGRESS → RECONCILED /
  HAS_VARIANCE → UNDER_REVIEW → APPROVED), exceptions with resolution, notes,
  attachments, four-eyes approval and the rule that an unexplained variance
  above materiality is never approved
- Company accounting policies (materiality, stale days)
- Seeded documents registered in the tax subledger so the sample company
  reconciles in every area from day one
- Tests: API integration 115 (+5 reconciliation scenarios)

### H3-H9 (planned)

Reconciliation center, financial close,
enterprise controls (SoD/approvals/suspense/history), data infrastructure
(imports, opening balances, numbering), reporting engine, reliability,
consolidation readiness.

## Beyond the roadmap

All nine phases of the specification are delivered. Candidates for follow-up
work: OCR for scanned images without a model backend (e.g. Tesseract), bank
feed connectors, multi-entity consolidation adjustments beyond intercompany
eliminations, and workflow rules on more document families.
