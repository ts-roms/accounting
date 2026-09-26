# Performance & scalability audit (2026-09, 10M journal lines)

How far does this platform scale - millions to tens of millions of journal lines - while
staying responsive and 100 % financially correct? This audit re-reads the existing performance
work (`docs/performance.md`), verifies it against the source, extends the method (a financially
valid generator, a correctness gate, posting / concurrency / failure harnesses) and measures a
10-million-line ledger.

**Labels used throughout.** **[F]** fact from the source (file:line). **[M]** measured in this
audit. **[H]** historical figure from `docs/performance.md` (not re-measured unless stated).
**[E]** estimate / extrapolation. **[R]** recommendation. Measurements are only comparable with
each other, never with [H] figures in absolute terms (different machine - see "Environment").

---

## 1. Executive summary

**What is good (verified).**

- The ledger design is sound and correctness held under every test: posting goes through one
  gateway (`AccountingPostingService`), invariants are enforced twice (service + DB CHECKs /
  triggers), posted rows are immutable, idempotency rests on unique indexes, and the
  period-balance read model is maintained by triggers in the posting transaction and proven by a
  check. **Every run in this audit - bulk load, 4-call API posting at 1-32 writers, mixed
  post / reverse / report load, 100 concurrent duplicate requests, `kill -9` of the API with 12
  transactions in flight, killed database connections - passed the new 23-check correctness
  gate** [M], and the application's own 23 integrity checks report OK with zero findings on the
  10M dataset (AR / AP / inventory / fixed assets / tax subledgers all reconcile) [M].
- The existing performance rules (single-account reads by `accountIds`, statements from the read
  model, stored integrity run on the main dashboard, reconciliation fan-out, authorization cache
  without figure caching) are implemented as documented [F].
- Navigation on the production build is unchanged at 10M lines: warm revisits 25-76 ms, first
  visits 32-226 ms to first content [M] - the documented numbers still hold [H].

**Major scalability risks (in priority order).**

| #   | Risk                                                                                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The API process crashes** when Postgres terminates a checked-out connection (failover, admin kill, any future `idle_in_transaction_session_timeout`). Jobs run in the same process.                                               | `pg_terminate_backend` during posting -> `Unhandled 'error' event` (57P01), process exit [M]; only idle clients have a listener (`database.module.ts:28`) [F]. Books stayed correct [M].                                                                                           |
| 2   | **Period-balance trigger deadlocks.** Lines are applied in unsorted line order; journals touching the same keys in opposite order deadlock (1 s `deadlock_timeout` each, no retry -> HTTP 500).                                     | 30 % of 2-line probe transactions deadlocked at 4 clients; 12.7 % when an auto-reversing GENERAL journal meets `postEvent` (counter <-> period-balance lock inversion); 20 deadlocks / 15 s once the counter is removed [M]. A sorted, aggregated trigger removed all of them [M]. |
| 3   | **The read model does not make statements volume-independent.** Its key includes branch x 3 dimensions x journal type, so with realistic dimension use it holds ~1 row per 2.5-4 lines. Statements scale ~linearly with the ledger. | 1.14M model rows for 4.6M lines [M]. Balance sheet 452 ms, trial balance 283-470 ms, 12-month trend 487 ms at 10M lines (vs 8-28 ms at 40K [H]) [M].                                                                                                                               |
| 4   | **Live integrity audits on request paths.** `/controls/dashboard` runs all 23 checks on every visit; `/integrity` is live. Several checks are whole-ledger scans.                                                                   | 26 s each at 4.6M lines [M]; `PERIOD_BALANCES_VS_LEDGER` 24.6 s alone with 189M join-filter evaluations and a 389 MB hash spill [M].                                                                                                                                               |
| 5   | **Posting throughput is capped per company-year** by the gapless JE counter row (held from allocation to commit), then by hot period-balance rows; any CPU contention (reports) stretches the lock hold and collapses posting.      | DB-level ceiling ~250-300 journals/s with the counter vs ~1,100/s without [M]; end-to-end 43-46 journals/s [M]; 16 writers drop from 45.6 to 7.7 journals/s (-83 %) when 4 trial-balance readers run [M].                                                                          |
| 6   | **Heavy-account general ledger and GL export are O(account lines), export O(n^2).**                                                                                                                                                 | GL pages 416-632 ms on a 227K-line account [M]; heavy YTD CSV export (124,600 rows) 299 s in one request [M]. A 10M-line account would not finish [E].                                                                                                                             |
| 7   | **Dashboard capacity at 10M lines is ~1.5 pages/s on 4 vCPU**, 99 % of its database time in four calls; pool size does not matter.                                                                                                  | 1 user saturates 4 cores; p50 6.2-6.7 s at 10 users, 13.7 s at 20 [M]; pool 10 / 20 / 40 -> 1.42 / 1.49 / 1.46 pages/s [M].                                                                                                                                                        |
| 8   | Webhook outbox drains slower than the ledger can post.                                                                                                                                                                              | ~400 events/min (one 200-event batch per 30 s tick) vs ~45 postings/s [M].                                                                                                                                                                                                         |
| 9   | Concurrent duplicate `POST /journal-entries` with the same body `idempotencyKey` return **500** (unique violation surfaces raw); still exactly one journal.                                                                         | 8 of 10 / 8 of 100 duplicates got 500 `journal_entries_idempotency_uq` [M].                                                                                                                                                                                                        |

**Bottom line.** Correctness is not the problem: it held everywhere. **Scalability to 10M+
lines is limited by (a) three whole-history read shapes (balance sheet, integrity checks,
single-account GL) that grow linearly with the ledger and (b) two serialization points in
posting (the JE counter row and hot period-balance rows).** None needs new infrastructure first:
the highest-value changes are code / SQL changes that the new tooling can prove before and
after (section 26).

---

## 2. Method and environment

| Item        | This audit [M]                                                                                                                                                         | 2026-09 baseline [H]                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Machine     | cloud VM, **4 vCPU**, 15 GB RAM, one disk; API, Postgres, load generator on the same host                                                                              | 16-core workstation                                |
| PostgreSQL  | 16.13 **native** (not Docker); `shared_buffers=2GB`, `work_mem=32MB`, `max_wal_size=2GB`, `pg_stat_statements`, `track_io_timing`                                      | 16 in Docker, defaults + `shm_size`                |
| API         | production build (`node dist/main.js`), `DATABASE_POOL_MAX=10` unless stated, `APP_CLOCK_FIXED_DATE=2026-09-18`                                                        | production build                                   |
| Web         | `next build` + `next start` (production)                                                                                                                               | production build and `next dev`                    |
| Dataset     | **1.65M journals / 10.03M lines**, 4 companies, 33 months (Jan 2024 - 18 Sep 2026), correlated dimensions, 3.1 % reversed, 3.5 % draft/submitted/approved (section 21) | 40,000 journals x 2 lines, 9 months, no dimensions |
| Correctness | `perf-verify.sql` after every scenario (all PASS) + the application's `/integrity` (OK)                                                                                | `/integrity`                                       |

Every run below was **financially verified**; a fast run failing the gate would have been reported
as failed. Numbers are p50 unless stated. This is a **developer-grade benchmark**: one small VM with
everything co-located. Treat absolute numbers as lower bounds on a production-class database host,
and the _ratios_ (model vs lines, with vs without counter, 1 vs N users) as the transferable
result. Datasets D-F (30M-300M lines) were **not** loaded: the VM had 23 GB of free disk; their
figures are extrapolations [E] with the method to measure them.

---

## 3. Verification of the existing performance claims

| Claim (docs / prompt)                                           | Verdict                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-account balances filter by account                       | **True** for `activity({ accountIds })` (`general-ledger.service.ts` `conditions`, index `journal_lines_account_idx`). **Not applied** by `ledger()` (the GL screen): its opening balance scans every line of the account before `from` (207 ms on the heavy account vs **3.5 ms** from the model [M]). |
| Whole-ledger reports use `account_period_balances`              | **True** (`activity`, `activityByMonth`, `splitWindow`). But the model compresses only 2.5-4x with dimensions [M], so the benefit is a constant factor, not volume independence: 5.3x on a Jan-Aug trial-balance window (164 vs 871 ms), yet the all-history balance sheet read is 399 ms [M].          |
| Dashboard integrity is stored, not recomputed                   | **True for `/dashboard`** (`/integrity/runs/latest`, 2 statements, 7 ms [M]). **False for `/controls/dashboard`**, which calls `IntegrityService.run` live (`controls.service.ts:65-71`) - 26 s at 10M [M] - and is in the `mixed` load scenario.                                                       |
| "Integrity checks stay bounded (single capped query, LIMIT 20)" | Output is capped; **work is not**: `UNBALANCED_JOURNAL` 9.4 s, `PERIOD_BALANCES_VS_LEDGER` 24.6 s per 4.6M-line company [M]. The 23 checks run through `Promise.all` - one run can take every pool connection (pool default 10).                                                                        |
| Reconciliation reads are fanned out                             | **True** (`reconciliations.service.ts:245-278` `Promise.all`). 61 statements, 162 ms of DB time, 57 ms wall alone [M]; under load each statement waits for a pool connection (p50 6 s at 10 dashboard users [M]).                                                                                       |
| Authorization cached, figures not                               | **True**: in-process `Map`, 30 s TTL (`authorization-cache.service.ts:21-27`); no figure cache found. Caveat [F]: invalidation is per process - with API replicas a revoked permission lingers up to the TTL on other replicas.                                                                         |
| Period balances maintained by triggers                          | **True** (migration `0037`): row-level triggers on `journal_lines` and `journal_entries.status`, same transaction; rebuild function; integrity check. Lock-order and write-cost issues in section 11.                                                                                                   |
| 40K journals / 80K lines benchmark                              | **True** (`perf-volume.sql`: 40,000 x 2 lines over 270 days, no dimensions, credits AR / AP controls directly - its data breaks subledger reconciliation).                                                                                                                                              |
| Dashboard 21 -> 16 calls                                        | **Now 17** (`PendingApprovalsCard` added `/approvals?mine=true`); `load-test.mjs` replayed 16 and hard-coded `2026-08-31` - both fixed.                                                                                                                                                                 |
| PostgreSQL CPU is the limit under dashboard load                | **Re-confirmed at 10M lines** on different hardware: waits are ~100 % on-CPU, load average 9-15 on 4 cores, Node 0.15-0.19 cores [M]. New: **one** user already saturates 4 cores (6 parallel requests x parallel query workers).                                                                       |
| Pool 20 -> 40 did not help                                      | **Re-confirmed**: pool 10 / 20 / 40 -> 1.42 / 1.49 / 1.46 pages/s [M].                                                                                                                                                                                                                                  |
| Larger pools exhausted Docker `/dev/shm`                        | Not reproducible here (native Postgres); mitigation `shm_size: 256m` is present [F]. Parallel workers inherit `application_name`, which is why "pg active/total" exceeds the pool size [M].                                                                                                             |
| Large improvement from the read model                           | **True but volume- and dimension-dependent** (see risk 3).                                                                                                                                                                                                                                              |
| Navigation numbers                                              | **Still accurate** on the production build (section 17). First-load JS: login 246 kB, heaviest route 350 kB (docs: 247 / 363) [M]. `nav-measure.mjs` could not run as documented (imports `playwright`, only `@playwright/test` is installed; ESM resolves next to the script) - fixed.                 |

---

## 4. Architecture map (as built)

```
Browser (React 19 client components, TanStack Query 5: staleTime 30 s, no focus refetch)
   │  fetch /api/v1/*  (same origin)
   ▼
Next.js 15 server (next start, output: standalone)  ── rewrites /api/* ──►  [gzip applied here]
   │  (every browser API call is proxied through the Next process)
   ▼
NestJS 11 API  (one Node process; Express; helmet; CsrfGuard; ThrottlerGuard in-memory;
   │            IdempotencyInterceptor; MetricsInterceptor; nestjs-pino per request)
   │    JwtAuthGuard ─► session check (every request, 1 SQL) ─► AuthorizationCacheService (Map, 30 s)
   │    Controllers (115, ~731 routes) ─► Services (own transactions, READ COMMITTED)
   │         ├─ AccountingPostingService.postEvent / postEntry / reverseEntry   (the only ledger writer)
   │         │     ├─ DocumentNumberingService.allocate  (row lock on document_sequences until COMMIT)
   │         │     ├─ AuditService.record(entry, tx)      (audit_logs [+ field_changes])
   │         │     └─ OutboxService.enqueue(tx, …)        (integration_events)
   │         ├─ GeneralLedgerService.activity / activityByMonth / ledger / lineActivity
   │         ├─ ReportingService, ReportEngineService, SubledgerBalancesService, IntegrityService …
   │         └─ In-process BullMQ workers + schedulers (JobRegistryService / JobRunnerService)
   ▼  node-postgres Pool (max DATABASE_POOL_MAX=10), Drizzle ORM
PostgreSQL 16  ── triggers: immutability guards, locked-period guard, period-balance maintenance
   ▲
Redis 7 (BullMQ queues: maintenance, accounting-schedules, integration-sync, webhook-delivery,
         webhook-inbound, integration-maintenance; prefix QUEUE_PREFIX)
External: integration connectors (Stripe, Plaid, …) via sync jobs; outbound webhooks via outbox;
          AI (HEURISTIC offline / providers) advisory only; OCR (Tesseract) local.
```

Verified stack [F]: next 15.5, react 19.1, @tanstack/react-query 5.87, @tanstack/react-table
8.21, react-hook-form 7.62, zod 4.1, tailwindcss 4.1, NestJS 11.1, drizzle-orm 0.45, pg 8.16,
bullmq 5.58, ioredis 5.7, nestjs-pino 4.4, Jest 29, Vitest 3.2, Playwright 1.55, pnpm 11 +
Turborepo 2.5, Docker Compose (postgres, redis, migrate, api, web). Packages: `types`,
`validation`, `config`, `money` (decimal.js), `ui`, `eslint-config`, `tsconfig`.

| Path type                   | Where                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synchronous (request)       | everything behind a controller, including posting, reports, **live integrity**, CSV exports (built fully in memory, `exports.service.ts:18-23, 105-124`)                                                                                                                |
| Asynchronous                | BullMQ repeatables in the API process (integrity nightly 03:45, accounting schedules 02:15, depreciation, sweeps, outbox dispatch every 30 s, retry every 15 s, sync every 60 s); `execute` holds a transaction + advisory lock (one pool connection) for the whole job |
| Database-heavy              | balance sheet / trial balance / trend / cash flow (model + partial-month lines), `IntegrityService.run`, `SubledgerBalancesService.compute`, GL of a heavy account, journal list `count(*)`, journal search `ILIKE '%…%'`                                               |
| CPU-heavy (Postgres)        | hash aggregates over lines / model rows with parallel workers; integrity full joins; window running balance in `ledger()`                                                                                                                                               |
| CPU-heavy (Node)            | request handling for many small calls (posting: Node ~1.1 cores at 45 journals/s [M]); `Money` (decimal.js) folding of `activity` rows; JSON serialization of 90-180 kB report payloads                                                                                 |
| Network-heavy               | trial balance 90 kB, GL 500-row page 180 kB, GL CSV 12 MB [M]; API sends no compression (Next's proxy gzips: 5-7x smaller [M])                                                                                                                                          |
| Round-trip bound (N+1-like) | `/reconciliations/summary` 61 statements, `/treasury/dashboard` 70, `/integrity` 80, `/controls/dashboard` 159 [M]                                                                                                                                                      |
| Serialization points        | JE counter row (per company / type / year), hot `account_period_balances` rows, single Node process, sequential outbox dispatch, in-memory throttler / authz cache (per process)                                                                                        |

---

## 5. Accounting data flow (source map)

```
Business document service (InvoicesService, BillsService, BankingService, PayRunsService, …)
  db.transaction(tx => …)                                   ← transaction begins (service)
    ├─ domain rows, status, allocations                     (the document)
    ├─ AccountingPostingService.postEvent(tx, event, { permission })
    │     assertAuthority → findExisting (idempotency / source identity)
    │     companyCurrency → validateLines (accounts, Money exact decimals, balanced)
    │     validateForPosting (branch restrictions, branches, DimensionsService.validateRefs,
    │                         DimensionRulesService.assertLines) → validateSource → resolvePeriod
    │     DocumentNumberingService.allocate('JE')            ← row lock held until COMMIT
    │     INSERT journal_entries (status APPROVED)
    │     INSERT journal_lines (multi-row)                   ← triggers: immutability guard,
    │                                                          period-balance (no-op: not in ledger)
    │     postEntry: SELECT … FOR UPDATE, re-read lines, re-validate, resolvePeriod
    │       UPDATE journal_entries SET status='POSTED'       ← trigger journal_entries_period_balance:
    │                                                          one upsert per line into
    │                                                          account_period_balances (row locks)
    │       AuditService.record(POST, tx)                    ← audit_logs
    │       OutboxService.enqueue(tx, journal.posted)        ← integration_events
    │       events.emit(JOURNAL_POSTED_EVENT)                (in-process, not transactional)
    │       autoReverseDate → reverseEntry → postEvent (mirror REVERSAL)
    └─ COMMIT                                               ← transaction ends
Reads:
  GeneralLedgerService.activity(filter) = Σ model rows for whole months + lineActivity for edge days
  ReportingService.trialBalance / incomeStatement / balanceSheet / cashFlow / trend  → activity()
  ReportEngineService (JSON layouts) → activity() + budget_lines
  GeneralLedgerService.ledger() → journal_lines ⨝ journal_entries only (opening, totals, window page)
Proof:
  IntegrityService.run (23 checks) incl. PERIOD_BALANCES_VS_LEDGER, subledger reconciliations
```

Manual journals: `JournalEntriesService.createIn` allocates the JE number at DRAFT
(`journal-entries.service.ts` ~L395), `post()` locks and calls `postEntry` (no counter). Audit
rows: `postEntry` writes `POST`; `JournalEntriesService.post` writes a second `POST` row with
`sodWarnings` when the approver posts (WARN policy) [F].

---

## 6. Financial invariants - verified against the implementation

| Invariant                                 | Enforcement [F]                                                                                                                 | Proven in this audit [M]                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Σdebit = Σcredit per entry                | `validateLines` (Money), CHECK `journal_entries_posted_balanced_chk` (header only)                                              | `ENTRY_BALANCED` (lines vs lines and vs header), 11.46M lines: 0                                      |
| debit ≥ 0, credit ≥ 0, one side, non-zero | 3 CHECKs on `journal_lines` + validation                                                                                        | `LINE_SIGNS`: 0                                                                                       |
| Account / company consistency             | `validateLines` (company filter); lines denormalise `company_id`                                                                | `COMPANY_CONSISTENCY`: 0                                                                              |
| Currency                                  | base-currency header, foreign columns + CHECKs                                                                                  | `BASE_CURRENCY`: 0                                                                                    |
| Closed / locked periods                   | `resolvePeriod` (OPEN / SOFT_CLOSED / CLOSED / LOCKED), trigger `journal_entries_guard_locked_period`                           | `LOCKED_PERIOD_POSTING`, `PERIOD_MATCH`: 0                                                            |
| Posted immutability                       | triggers `journal_entries_immutable_when_posted`, `…_no_delete_when_posted`, `journal_lines_immutable_when_posted`              | pgbench / API writes never tripped them; generator must disable them to bulk-load (documented)        |
| Reversal                                  | `reverseEntry` → mirror REVERSAL, source `JOURNAL_REVERSAL` (unique), original `REVERSED`                                       | `REVERSAL_PAIRS`, `REVERSAL_NETS_TO_ZERO`, `DOUBLE_REVERSAL`: 0; 100 concurrent reverses → 1 reversal |
| Sequential document numbers               | `DocumentNumberingService.allocate` atomic upsert in the caller's transaction                                                   | `DUPLICATE_DOCUMENT_NUMBER`, `JE_NUMBER_BEYOND_COUNTER`: 0 under 64 concurrent posters                |
| Idempotent posting                        | unique `(company, idempotency_key)`, `(company, source_type, source_id)`; `postEntry` no-op when posted; HTTP `Idempotency-Key` | ×2 / ×10 / ×100 concurrent post, post-with-key, create, reverse → exactly 1 posting each              |
| TB balances; A = L + E + current earnings | `ReportingService` `balanced` flags                                                                                             | `TRIAL_BALANCE`, `ACCOUNTING_EQUATION` per company: 0                                                 |
| Read model = ledger                       | triggers + `PERIOD_BALANCES_VS_LEDGER`                                                                                          | uncapped key-by-key diff: 0 after every scenario                                                      |
| Audit completeness                        | `AuditService.record(…, tx)` in the posting transaction                                                                         | `POST_WITHOUT_AUDIT`, `ORPHAN_POST_AUDIT`: 0 after crash tests                                        |

Gaps found: the header CHECK compares header totals, not lines (lines are proven only by the
integrity check); concurrent duplicate creates return 500 (correct outcome, wrong contract).

---

## 7. Performance paths (actual routes)

| Class             | Routes (examples, all under `/api/v1`)                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactional     | `POST /journal-entries`, `/:id/submit`, `/:id/approve`, `/:id/post`, `/:id/reverse`, `/:id/correct`; invoices, bills, customer / vendor payments, bank transactions, expense claims, pay runs, lease runs |
| Ledger reads      | `GET /general-ledger`, `GET /journal-entries` (+ `search`, `summary`), `GET /accounts`                                                                                                                    |
| Financial reports | `GET /reports/trial-balance`, `/income-statement`, `/income-statement/trend`, `/balance-sheet`, `/cash-flow`, report engine runs                                                                          |
| Reconciliation    | `GET /reconciliations/summary`, `/reports/ar-reconciliation`, `/ap-reconciliation`, bank reconciliation, `GET /integrity`                                                                                 |
| Dashboards        | `/dashboard` (17 calls), `/treasury/dashboard`, `/controls/dashboard`, `/reports/ar-aging`, `/ap-aging`, receivables / payables dashboards                                                                |
| Background        | BullMQ jobs (section 16), `POST /integrity/runs`, `GET /exports` (synchronous), imports (`modules/data-infrastructure`), forecasts, AI anomaly scan, OCR                                                  |

---

## 8. Current performance baseline

### 8.1 Historical (2026-09, 40K journals, 16 cores, Docker) [H]

Statements 7-10 ms from the model (35-60 ms lines-only); dashboard 1 user 4.5 pages/s p50 177 ms;
10 users 7.2 pages/s p50 1.36 s; `/integrity` 191 ms; `/controls/dashboard` 227 ms.

### 8.2 New: single-request latency at 10M lines [M]

`report-bench.mjs`, ACME (757K journals / 4.6M lines / 1.14M model rows), 3 rounds, warm,
sequential. The 130K-line column is the same bench on the small dataset.

| Case                                   | 130K lines   | **10M lines**       | bytes (gzip)     |
| -------------------------------------- | ------------ | ------------------- | ---------------- |
| Trial balance, one day                 | 89 ms        | **470 ms**          | 90 kB (18 kB)    |
| Trial balance, month-to-date           | 45           | **357**             | 90 kB (18 kB)    |
| Trial balance, full month              | 29           | **345**             | 91 kB            |
| Trial balance, 12 whole months         | 25           | **283**             | 92 kB            |
| Trial balance, 24 whole months         | 33           | **338**             | 92 kB            |
| Trial balance, year-to-date            | 59           | **380**             | 92 kB            |
| Income statement, month-to-date        | 33           | **103**             | 49 kB (8 kB)     |
| Income statement, year-to-date         | 41           | **206**             | 54 kB (9 kB)     |
| Income statement trend, 6 / 12 months  | 61 / 74      | **292 / 487**       | 2-3 kB           |
| Balance sheet, as of today / month end | 65 / 30      | **452 / 339**       | 27 kB (5 kB)     |
| Cash flow, year-to-date                | 50           | **339**             | 22 kB (5 kB)     |
| GL heavy account (227K lines), MTD p1  | 52           | **514**             | 36 kB (6 kB)     |
| GL heavy, YTD p1 / p500 / 500-row page | 23 / 42 / 32 | **416 / 632 / 420** | 36 / 36 / 180 kB |
| GL cold account, YTD p1                | 8            | **61**              |                  |
| Journal list p1 / p2000                | 8 / 142      | **38 / 925**        | 31 kB            |
| Journal search (`search=`)             | -            | **663-814**         |                  |
| Reconciliation summary                 | 50           | **56**              | 2 kB             |
| Treasury dashboard                     | 49           | **69**              | 16 kB            |
| **Controls dashboard**                 | 512          | **26,310**          | 2 kB             |
| **Integrity (live)**                   | 484          | **26,608**          | 3 kB             |
| Integrity latest run                   | 4            | **7**               |                  |

A trial balance always computes an all-history opening balance, which is why "one day" is the
slowest trial balance: the cost is the model rows before `from`, plus edge days from lines.

### 8.3 Statements and database time per request [M]

`pg_stat_statements`, one request, min of 2-3 (background jobs share the database):

| Endpoint                             | statements | DB exec      | wall       |
| ------------------------------------ | ---------- | ------------ | ---------- |
| `/reports/balance-sheet` (today)     | 5          | 431 ms       | 445 ms     |
| `/reports/balance-sheet` (month end) | 4          | 350          | 361        |
| `/reports/income-statement/trend`    | 5          | 321          | 346        |
| `/reconciliations/summary`           | 61         | 163          | 57         |
| `/treasury/dashboard`                | 70         | 3            | 47         |
| `/integrity`                         | 80         | 1,066 (130K) | 471 (130K) |
| `/controls/dashboard`                | 159        | 1,206 (130K) | 531 (130K) |
| every other dashboard call           | 2-6        | < 3          | 3-7        |

---

## 9. Bottleneck analysis

Each: **Symptom → Evidence → Root cause → Change → Expected impact → Verify → Trade-offs.**

### B1. API process crashes on a server-side disconnect (critical, availability)

- **Symptom**: all requests fail, the process exits; in-process jobs die with it.
- **Evidence** [M]: `pg_terminate_backend` of the 10 API connections during 16-writer posting →
  `node:events Unhandled 'error' event … code 57P01`, exit; health check no response. After restart
  `perf-verify`: PASS (no partial journal, no orphan audit).
- **Root cause** [F]: `pool.on('error')` covers only idle clients (`database.module.ts:28`); a
  checked-out client between statements of a transaction has no `error` listener.
- **Change** [R]: `pool.on('connect', (client) => client.on('error', (err) => logger.warn(…)))` (the
  in-flight query still rejects; the transaction rolls back), plus a test that terminates backends.
  Do this **before** adding `idle_in_transaction_session_timeout`, which would otherwise trigger the
  crash.
- **Impact**: one failed request per killed connection instead of a process restart.
- **Verify**: rerun the backend-termination test (section 20); API stays up; gate PASS.
- **Trade-offs**: none.

### B2. Deadlocks in the period-balance trigger

**Status: fixed** - migration `0040_period_balance_lock_order.sql` (sorted, aggregated
upserts), `postEntry` allocates the auto-reversal's number before the status flip, and 40P01 /
40001 return 409 `TRANSACTION_CONFLICT` instead of 500. After the fix the deadlock probe runs
at 0 % failures, 303 tps on the 10M database [M]; two e2e tests in `period-balances.e2e-spec.ts`
fail on the old code and pass on the new. An automatic server-side retry was not added: it would
re-run in-process side effects (`JOURNAL_POSTED_EVENT`), so clients retry the 409 instead.

- **Symptom**: 1-s stalls then HTTP 500 on posting; throughput collapse under concurrency.
- **Evidence** [M]: `pgbench/deadlock-pair.sql` (2-line journals, opposite order, 4 clients):
  30 % deadlock failures, 1.9 tps; `accrual-inversion.sql` + `post-event.sql`: 12.7 % deadlocks,
  180 → 6 tps (GENERAL-typed auto-reversing journal; ACCRUAL-typed ones use another model key and
  did not deadlock); `post-event.sql` without the counter: 3 deadlocks at 16 clients, 20 at 64.
- **Root cause** [F]: `journal_entries_period_balance` loops `SELECT * FROM journal_lines WHERE …`
  **without ORDER BY** and upserts one model row per line, so lock order follows line order; and
  `postEntry` takes model-row locks (status flip) **before** `reverseEntry → postEvent` takes the JE
  counter, the inverse of every other posting. The counter lock currently masks most cases by
  serializing `postEvent` callers per company-year. No 40P01 retry anywhere [F].
- **Change** [R]: (1) apply the lines as **one** `INSERT … SELECT … GROUP BY key ORDER BY key ON
CONFLICT DO UPDATE` (`infrastructure/scripts/pgbench/candidate-sorted-trigger.sql`); (2) allocate
  the auto-reversal's number before flipping the original's status (or allocate numbers in
  `postEntry` first); (3) retry the whole transaction once on 40P01 / 40001 at the posting service
  boundary (safe: idempotent by source identity, the failed attempt rolled back entirely).
- **Impact** [M]: deadlock probe 30 % → 0 %, 1.9 → 252 tps; without the counter 245 tps / 20
  deadlocks → 1,060 tps / 0 deadlocks; a 300-line journal's status flip 6.5 → 3.7 ms.
- **Verify**: the three pgbench scenarios + `perf-verify.sql` + `apps/api/test/period-balances.e2e-spec.ts`.
- **Trade-offs**: migration replaces a trigger function (reviewed SQL, e2e); same arithmetic.

### B3. The read model scales linearly with dimension use

- **Symptom**: statement latency grows with the ledger: 25-89 ms at 130K lines → 283-470 ms at 10M.
- **Evidence** [M]: model rows vs lines per company: 1.0M lines → 397K rows (2.5 lines/row),
  4.6M → 1.14M (4.0). All-history balance sheet read: 399 ms over 1.11M rows (index scan, 472K
  buffers, all in cache).
- **Root cause**: the key is (company, account, month, journal type, branch, department, cost
  centre, project). Statement reads without dimension filters (dashboard, balance sheet, trial
  balance) still sum every dimension row. The 40K baseline had no dimensions, so the model looked
  ~1 row per account-month there.
- **Change** [R] (measure each):
  1. **Cheap**: covering index `(company_id, period_start) INCLUDE (account_id, journal_type,
debit, credit)` → 399 → 201 ms (index-only scan) [M]. Write cost: one more index entry per
     model upsert (non-HOT updates on hot rows).
  2. **Structural**: a second trigger-maintained rollup keyed (company, account, month, journal
     type) used when no branch / dimension filter is present → 40,273 rows instead of 1.14M;
     balance sheet **399 → 21 ms (19x)** [M, read side on a static copy]. Must be proven by its own
     integrity check and rebuild function, exactly like 0037; the write side adds one upsert per
     distinct (account, month, type) per posting on a **hotter** row - measure with
     `pgbench/post-event.sql -D balspread=1` before adopting.
  3. Balance-sheet opening via yearly rollups (years + months of the current year) if (2) is not
     enough.
- **Impact** [E]: dashboard DB time is 87 % the two balance sheets + trend; (2) cuts those ~10x
  → roughly 3-4x dashboard capacity on the same hardware.
- **Verify**: `report-bench.mjs` BS / TB / trend rows, `load-test.mjs dashboard 10`, `perf-verify.sql`.
- **Trade-offs**: another derived table (not a second source of truth only if trigger-maintained,
  proven, rebuildable - the 0037 pattern); more write amplification per posting.

### B4. Live whole-ledger integrity on request paths

- **Symptom**: `/controls/dashboard` and `/integrity` 26 s; a single request occupies up to 23 pool
  connections (`Promise.all`).
- **Evidence** [M]: 80 / 159 statements; `UNBALANCED_JOURNAL` 9.4 s, `PERIOD_BALANCES_VS_LEDGER`
  24.6 s (hash key only account / month / type; the four nullable dimensions are join **filters**:
  189,372,126 rows removed; 389 MB spill). Application integrity scales ~5.6 s per million lines
  (ACME 25.9 s / 4.6M, PERF01 10.8 s / 2.8M: 4-6 s per million lines).
- **Root cause**: whole-history scans by design; `IS NOT DISTINCT FROM` is not hashable.
- **Change** [R]: (1) `/controls/dashboard` shows the stored `integrity_runs` row like `/dashboard`
  (the documented rule); (2) join on `coalesce(dim, nil-uuid)` - **24.6 → 11.5 s** [M], 9.1 s with
  `work_mem=512MB` for that query [M]; (3) incremental integrity: check only months / entries touched
  since the last run (watermark on `posted_at` / the model's changed months) nightly, full sweep
  weekly; (4) run the checks with bounded concurrency (e.g. 4) instead of 23 at once.
- **Verify**: `report-bench.mjs "Controls|Integrity"`, `perf-explain.sql` Q8 / Q9.
- **Trade-offs**: incremental checks need a proven watermark; keep a periodic full sweep.

### B5. Posting serialization: the gapless JE counter and hot model rows

- **Symptom**: posting throughput stops rising at ~4 concurrent posters and falls under contention.
- **Evidence** [M] (`pgbench/post-event.sql`, 2-6 lines, audit + outbox, 10M ledger):

  | clients | counter + spread accounts      | no counter + spread | counter + one hot account | no counter + one hot account |
  | ------- | ------------------------------ | ------------------- | ------------------------- | ---------------------------- |
  | 1       | 213 tps (4.7 ms)               | 241                 | 273                       | -                            |
  | 4       | **260** (counter wait 10.8 ms) | **931**             | **305**                   | 764                          |
  | 16      | 247 (wait 60 ms)               | 911 (3 deadlocks)   | 282 (wait 52 ms)          | 647 (row wait 21 ms)         |
  | 64      | 203 (wait **305 ms**)          | 245 (20 deadlocks)  | 221 (wait 280 ms)         | 349 (row wait **173 ms**)    |

  End-to-end through the API (4-call UI flow): 1 writer 21 journals/s (p50 46 ms per journal),
  4 → 43, 16 → 46, 32 → 43 (create p99 2.6 s) [M]; Node ~1.1 cores (its ceiling) and backends
  waiting on `Lock:transactionid` [M]. With 4 trial-balance readers: **7.7 journals/s** (-83 %).

- **Root cause** [F]: `allocate()` upserts `document_sequences` in the caller's transaction and the
  row lock lasts until COMMIT; gapless numbering is inherently serial. `postEvent` allocates
  _early_ (before inserts, audit, outbox), so the hold time is almost the whole transaction; CPU
  contention stretches it further.
- **Change** [R] (in order):
  1. Allocate as **late** as possible inside the transaction (after validation and line inserts,
     right before the status flip), keeping gaplessness: shorter hold → higher ceiling.
  2. Decide per document type whether JE numbers must be gapless (a legal requirement for
     invoices in many jurisdictions, rarely for internal journal numbers). Where not, use a
     sequence (`nextval`, non-transactional → gaps on rollback): 260 → 931 tps on this box [M].
  3. Hot model rows: the sorted trigger (B2); if a single account (bank clearing) is the limit,
     stripe its model key (e.g. `stripe smallint` 0..N-1 by `txid % N`, summed on read).
  4. Keep reports off the posting CPUs (B3 first; then a read replica for reports - section 25).
- **Verify**: the pgbench matrix above + `posting-test.mjs throughput|mixed` + `perf-verify.sql`.
- **Trade-offs**: gapless numbering is a business / legal decision, not a tuning knob.

### B6. Heavy-account general ledger and GL export

- **Evidence** [M]: opening balance 207 ms (reads all 227K lines, joins entries for date / status);
  page 500 = 208-249 ms (window over the whole range, then OFFSET); YTD CSV export of 124,600 rows
  **299 s** in one request, 12 MB, +90 MB RSS; one month (8,672 rows) 10.7 s.
- **Root cause** [F]: `journal_lines` has no date; `ledger()` does not use the model; export loops
  `ledger()` with OFFSET (O(n²)) and builds the CSV in memory.
- **Change** [R]: (1) opening balance through `activity({ accountIds, to: from-1 })` → **3.5 ms**
  [M]; (2) denormalise `entry_date` (immutable once posted, set by trigger while draft) onto
  `journal_lines` with a partial index `(company_id, account_id, entry_date, …) WHERE in ledger`
  and keyset pagination → page 500 in **0.6 ms** [M] (running balance = opening + Σ before the
  cursor, served by the same index); (3) GL export streams with a keyset cursor (or becomes a
  BullMQ job with a download link above N rows).
- **Trade-offs**: (2) is a schema change on the largest table (backfill in batches); one more index
  on every line insert.

### B7. Journal list and search

- **Evidence** [M]: page 2000 925 ms (OFFSET), exact `count(*)` 52 ms per list call at 757K
  journals; search `ILIKE '%…%'` over number / description / reference 663-814 ms.
- **Change** [R]: keyset pagination for deep pages; `pg_trgm` GIN index on
  `(document_number, description, reference)` (write cost: one GIN insert per journal, fastupdate);
  capped / estimated counts beyond N.

### B8. Outbox dispatch lags posting

- **Evidence** [M]: 16,530 pending events drained at 400/min (200 per 30 s tick); posting produced
  ~45/s. **Root cause** [F]: `pending(200)` per run, events processed sequentially, no `SKIP LOCKED`.
- **Change** [R]: loop until drained per run; `FOR UPDATE SKIP LOCKED` batches so several workers
  can dispatch; measure lag (`occurred_at` of the oldest pending) as a metric.

### B9. Duplicate create returns 500

- **Evidence** [M]: `posting-test.mjs duplicates`: same body `idempotencyKey` x10 → 2 x 201 + 8 x 500
  (`journal_entries_idempotency_uq`), one journal. **Root cause** [F]: check-then-insert without
  catching 23505 (`journal-entries.service.ts` `createIn`).
- **Change** [R]: on unique violation of `journal_entries_idempotency_uq`, re-read and return the
  existing entry (the concurrent loser waits on the counter lock, so the winner is committed).

### B10. Minor, measured

- Redundant index `journal_lines_entry_idx` (168 MB at 10M lines, one extra insert per line) -
  covered by `journal_lines_entry_number_uq`'s leading column [M/F]. Dimension indexes on lines
  (211 MB) had 6-16 scans in the whole audit [M] - confirm against production
  `pg_stat_user_indexes` before dropping.
- `account_period_balances.id` + PK (157 MB, 0 scans) is never used; the unique key is the identity.
- The `Idempotency-Key` claim is held `IN_PROGRESS` for up to 24 h after a crash between claim and
  completion (`IDEMPOTENCY_TTL_MS`), so a client retry gets 409 for a day; use a short in-progress
  lease (e.g. 60 s) separate from the replay TTL [F].
- `JobRegistryService.execute` holds a transaction (and a pool connection) for the whole job
  (`pg_try_advisory_xact_lock`) - with pool 10, a long nightly job permanently takes 10 % of it.

---

## 10. Data scalability (80K → 100M+ lines)

Measured per-unit costs on this VM [M]: journal_lines 290 B/line (table + 8 indexes), journal
entries 427 B, model 416 B/row, audit 519 B/row, outbox 489 B/row; the live integrity run 4-6 s
per million lines per company; statement reads ~0.35 ms per thousand model rows (warm).

| Lines (one company) | Model rows [E, from 2.5-4 lines/row trend] | Balance sheet (model) | Trial balance  | Integrity (live) | GL 227K-line-account page | Notes                               |
| ------------------- | ------------------------------------------ | --------------------- | -------------- | ---------------- | ------------------------- | ----------------------------------- |
| 80K [H]             | ~1K (no dims)                              | 8 ms [H]              | 10 ms [H]      | 191 ms [H]       | -                         | baseline                            |
| 1M [M: PERF03]      | 397K                                       | ~140 ms [E]           | ~120 ms [E]    | ~6 s [E]         |                           |                                     |
| 4.6M [M: ACME]      | 1.14M                                      | **452 ms**            | **283-470 ms** | **26 s**         | **416-632 ms**            | measured                            |
| 10M [E]             | ~2.2M                                      | ~0.8 s                | ~0.7 s         | ~55 s            | ~1 s (if 500K lines)      | linear                              |
| 50M [E]             | ~8-10M                                     | ~3-4 s                | ~3 s           | ~5 min           | ~5 s                      | dashboard unusable without B3       |
| 100M [E]            | ~15-20M                                    | ~6-7 s                | ~6 s           | ~10 min          | ~10 s                     | needs B3 + B6 + partitioning review |

With B3 (rollup) the balance sheet / trial balance become ~O(accounts x months) (≈ 40K rows at
4.6M lines, growing only with months), i.e. roughly flat from 10M to 100M lines [E]. With B6 the
GL becomes O(page) (keyset) plus O(1) opening. With incremental integrity (B4), nightly cost
becomes O(new lines).

**Partitioning** [R, only after B3/B6]: at 100M+ lines per database, range-partition
`journal_lines` by entry month (requires `entry_date` on lines - B6) for maintenance (VACUUM, index
rebuild, archival), not primarily for read speed. Partitioning without a date on the line is not
possible, which is one more reason for B6.

---

## 11. The period-balance read model (section 11 of the brief)

| Question                    | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How is it updated?          | [F] row trigger on `journal_lines` INSERT / DELETE (applies only when the entry is already in the ledger - one `SELECT journal_entries` per line even when not) and on `journal_entries` status entering / leaving the ledger (loops over the lines, one upsert each).                                                                                                                                                                   |
| Indexes                     | [F] unique key (8 columns, NULLS NOT DISTINCT) 415 MB, `(company_id, period_start)` 32 MB, PK on an unused `id` 157 MB at 2.9M rows [M].                                                                                                                                                                                                                                                                                                 |
| High-volume posting         | [M] trigger cost per posting: 4-line journal 4.7 vs 3.5 ms without triggers (**+34 %**); 300-line journal 29.4 vs 22.7 ms (**+29 %**); the sorted, aggregated candidate: +10 % / +4 %.                                                                                                                                                                                                                                                   |
| Concurrent writes           | [M] deadlocks (B2); hot rows serialize posters on one account once the counter is gone (row wait 173 ms at 64 clients).                                                                                                                                                                                                                                                                                                                  |
| Do reads scale?             | [M] constant-factor only (B3): 5.3x on a Jan-Aug window, but all-history reads grow with model rows.                                                                                                                                                                                                                                                                                                                                     |
| Rebuild                     | [M] `rebuild_account_period_balances` for all four companies (10.03M lines → 2.92M rows): **87 s**; ACME alone (4.6M lines) ~40 s. It is a DELETE + INSERT … SELECT in one transaction; its interaction with concurrent postings was not tested here (a posting that creates a new key mid-rebuild can make the rebuild fail on the unique key) - run it in a quiet window and prove it with `PERIOD_BALANCES_VS_LEDGER` afterwards [R]. |
| Integrity affordable?       | [M] 24.6 s per 4.6M-line company as written, 11.5 s with hashable keys (B4).                                                                                                                                                                                                                                                                                                                                                             |
| Direct aggregation vs model | [M] trial-balance window: 871 ms lines vs 164 ms model; all-history: model 399 ms, covering index 201 ms, dimension-free rollup 21 ms.                                                                                                                                                                                                                                                                                                   |
| Partial months              | [M] month-to-date lines: 111 ms at 4.6M lines (Sep 1-18). Every "as of today" read (dashboard balance sheet, trend, trial balance to today) pays it. Cost scales with **current-month volume**, not history.                                                                                                                                                                                                                             |

**Partial-period matrix** [M, ACME]: one day 470 ms, one week 413 ms, month-to-date 357 ms, full
month 345 ms, year-to-date 380 ms, mid-month edges on both ends 459 ms (trial balance, dominated by
the all-history opening). Partial-day windows are not unexpectedly expensive on their own (edge
queries 50-110 ms) - the opening balance is.

---

## 12. Transaction throughput

- **Per posting (1 client, DB only)** [M]: 4.7 ms for a 4-line journal including audit + outbox;
  29 ms for 300 lines.
- **Ceiling per company-year** [M]: ~250-300 journals/s (gapless counter) on this VM, falling with
  more concurrency; ~1,000-1,100/s with a sequence + sorted trigger.
- **End-to-end** [M]: 43-46 journals/s through the 4-call UI flow (≈ 180 requests/s) from 4 writers
  up; limited by the single Node process (~1.1 cores) and counter waits. API replicas raise the
  request ceiling but **not** the per-company counter ceiling.
- **Under reporting load** [M]: -83 % (B5).
- **Correctness under concurrency** [M]: all runs PASS; no duplicate numbers, no lost / partial
  journals, model exact, audit complete.

---

## 13. Reporting scalability

See 8.2 and B3. Payloads [M]: trial balance ~90 kB (18 kB gzipped), income statement 49-54 kB,
balance sheet 27 kB, cash flow 22 kB, GL page 36 kB (100 rows) / 180 kB (500 rows). Statement
payloads are bounded by the chart (hundreds of rows), not by ledger volume - **pagination /
streaming is not needed for statements**; it is needed for the GL export (B6). The browser gets
gzip through Next's rewrite (5-7x smaller) [M]; direct API clients get none - enable compression
at the ingress (or `compression` in Nest) if clients call the API directly [R].

---

## 14. Dashboard scalability [M]

| Users (closed loop, no think time) | pages/s   | page p50   | p95        | p99        | machine CPU         | Node |
| ---------------------------------- | --------- | ---------- | ---------- | ---------- | ------------------- | ---- |
| 1                                  | 1.25-1.29 | 772-798 ms | 860-876 ms | 1.0 s      | 3.75 cores          | 0.15 |
| 10                                 | 1.42-1.54 | 6.2-6.7 s  | 7.9-8.2 s  | 9.3-10.3 s | 4.0 (load avg 12.6) | 0.18 |
| 20                                 | 1.45      | 13.7 s     | 14.6 s     | 14.9 s     | 4.0                 | 0.19 |

Capacity model [M]: ~2.7 CPU-seconds per dashboard load / 4 cores ≈ 1.5 pages/s = the plateau.
Dominant endpoints: balance sheet (x2), trend, reconciliation summary = 99 % of DB time. Under load
the cheap calls (agings, `/roles`) wait seconds for a pool connection or CPU - fixing them does
nothing; fixing B3 does. Warm vs cold: React Query `staleTime` 30 s means a revisit within 30 s
makes no calls (navigation warm hops 25-76 ms) [M]; authorization cache hits cost 1 query
(session check), misses 6 [F]. The main dashboard's integrity card is the stored run (7 ms).

---

## 15. Reconciliation

[F] `ReconciliationsService.summary`: five areas via `SubledgerBalancesService.compute` and every
bank account, fanned out with `Promise.all`; 61 statements [M], 162 ms DB / 57 ms wall alone; 6 s
p50 at 10 dashboard users (queueing, not its own cost). No locks taken (reads only). It does not
slow posting on its own; the **trial-balance / statement readers do** (B5). Recommendation [R]:
collapse the per-area control balances into one `activity({ accountIds: [...all control
accounts] })` call and the bank accounts into one grouped query (61 → ~10 statements), then
re-measure with `load-test.mjs dashboard` + `posting-test.mjs mixed`.

---

## 16. PostgreSQL analysis

### 16.1 Plans (warm, ACME 4.6M lines; `infrastructure/scripts/perf-explain.sql`)

| Query                                 | Plan summary                                                                                                       | Time        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- |
| Q1 model, Jan-Aug (TB / statements)   | Parallel index scan `apb_company_period_idx` (318K rows) → hash join accounts → partial hash agg; 133K buffers hit | 164 ms      |
| Q2 same window from lines             | parallel hash join lines ⨝ entries, ~3M lines                                                                      | 871 ms      |
| Q3 month-to-date edge from lines      | entries by `(company_id, entry_date)` → lines by entry                                                             | 111 ms      |
| Q4 model, all history (balance sheet) | parallel index scan 1.11M rows, 472K buffers hit, no disk                                                          | 399 ms      |
| Q5 GL heavy opening                   | parallel index scan `journal_lines_account_idx` (227K) ⨝ parallel bitmap heap scan of entries (497K)               | 265 ms      |
| Q6 / Q7 GL heavy page 1 / page 500    | window over all YTD rows then LIMIT / OFFSET                                                                       | 52 / 249 ms |
| Q8 `UNBALANCED_JOURNAL`               | group by entry over all ledger lines                                                                               | 9.4 s       |
| Q9 `PERIOD_BALANCES_VS_LEDGER`        | seq scan 10M lines; hash full join on 3 keys, **189M rows removed by join filter**, hash agg spill 389 MB          | 24.6 s      |
| Q10 journal list `count(*)`           |                                                                                                                    | 52 ms       |

No unexpected sequential scans on request paths except Q9 / Q8 (by design) and journal search
(ILIKE). No sorts spilled except Q9's hash aggregate (`work_mem` 32 MB here; the default 4 MB would
spill more).

### 16.2 Index recommendations (each with the query it serves and its cost)

| Index / change                                                                                        | Serves                                     | Measured / expected gain  | Write & storage cost                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------- | ----------------------------------------------------------------------- |
| drop `journal_lines_entry_idx`                                                                        | nothing (redundant)                        | -                         | saves 168 MB + 1 insert per line                                        |
| `(company_id, period_start) INCLUDE (account_id, journal_type, debit, credit)` on the model           | Q1 / Q4                                    | 399 → 201 ms [M]          | +~150 MB at 2.9M rows; extra index write per model upsert (defeats HOT) |
| `journal_lines (company_id, account_id, entry_date, …) WHERE in ledger` (needs `entry_date` on lines) | GL page / opening / export, heavy accounts | 208 → 0.6 ms (keyset) [M] | ~40 B/line + backfill                                                   |
| `pg_trgm` GIN on journal number / description / reference                                             | journal search                             | 0.7 s → ms-range [E]      | GIN insert per journal                                                  |
| model `fillfactor = 80`                                                                               | HOT updates of hot model rows              | fewer index writes [E]    | +20 % table size                                                        |

### 16.3 Connection pool (section 21 of the brief)

- Current [F]: `DATABASE_POOL_MAX` default 10 (max 100), one API instance, Postgres
  `max_connections` default 100; each parallel query adds up to 2 workers (`max_parallel_workers_per_gather` 2).
- Measured [M]: pool 10 / 20 / 40 → same throughput; the limit is CPU (all backends on-CPU, run
  queue 9-15 on 4 cores).
- **When a bigger pool helps**: when requests wait for a connection while the database has idle
  CPU (round-trip-bound work: reconciliation's 61 statements, network latency between API and DB).
  **When it only adds contention**: when the database is CPU- or lock-bound - more concurrent
  queries just share the same cores (and more parallel workers + hash tables consume memory /
  `/dev/shm` in Docker).
- **Recommendation** [R]: keep ~2-4x the database's cores across **all** API instances (e.g. 8-16
  on a 4-core DB), cap parallel workers per query for OLTP connections, and set `statement_timeout`
  (reports: e.g. 30 s; posting: e.g. 10 s), `lock_timeout` (e.g. 5 s) and
  `idle_in_transaction_session_timeout` - **after** B1. Add PgBouncer (transaction mode) only when
  instance count x pool exceeds what the server should run concurrently; the app uses no session
  state except `pg_try_advisory_xact_lock` (transaction-scoped: compatible).

### 16.4 CPU bottleneck separation [M]

| Workload            | Machine (4 cores) | Node API | load generator | Postgres (rest) | Verdict                        |
| ------------------- | ----------------- | -------- | -------------- | --------------- | ------------------------------ |
| Dashboard, 1 user   | 3.75              | 0.15     | 0.02           | ~3.6            | DB CPU                         |
| Dashboard, 10 users | 4.00              | 0.18     | 0.03           | ~3.8            | DB CPU                         |
| Posting, 16 writers | 2.28              | **1.11** | -              | ~1.1            | Node single thread + row locks |

`load-test.mjs` now prints this split (machine-wide `/proc/stat` minus API and generator -
short-lived parallel workers make per-process sums undercount).

---

## 17. Frontend analysis [M/F]

- Production build, 10M-line API: warm hops 25-76 ms, first visits 32-226 ms first content,
  settled ≤ 415 ms (treasury / bank feed / journal entries wait on their API). Documented [H]
  figures still hold.
- First-load JS [M]: login 246 kB, dashboard 323 kB, heaviest 350 kB, shared 102 kB.
- **General ledger UI** [F]: server-side offset pagination, fixed `pageSize=100` (API max 500),
  plain table (no TanStack, no virtualization), no client sort / filter. The browser never holds more
  than one page, so 1K / 10K / 100K / 1M-row accounts cost the browser the same; the cost is the
  server (B6). Virtualization is **not** needed at 100-500 rows per page; keyset pagination is.
- DataTable [F]: `manualPagination` / `manualSorting`, page sizes ≤ 100, core row model only.
- Statements: all rows in one response (chart-bounded), totals from the server; the financial
  statements page fires three report queries on mount whatever tab is open [F] - fire the active tab
  first [R].
- Dashboard [F]: `Money` arithmetic in the browser for tiles; `/users`, `/roles`, `/companies`,
  `/audit-logs`, `/approvals`, notifications fire even without the permission (403s) - gate them with
  `enabled` [R].
- All API calls go through the Next server rewrite [F]: fine for gzip, but it puts Next on every
  API hop; in production route `/api` at the ingress directly to the API (keep the rewrite for dev)
  and enable compression there [R].
- Exports [F]: CSV only, built in memory, synchronous; see B6.

---

## 18. Node / NestJS

- [M] Posting at 45 journals/s drives the API to ~1.1 cores (one event loop + GC). Report reads are
  DB-bound (Node 0.15-0.19 cores at dashboard saturation). No CPU-intensive report computation
  was found in Node beyond `Money` folding of `activity` rows (hundreds to a few thousand rows per
  statement) - moving reports to workers is **not** justified by the evidence.
- [F] No event-loop-lag / ELU metric exists (`/metrics` is hand-rolled: HTTP histogram, job runs,
  queue gauge). Add `perf_hooks.monitorEventLoopDelay()` p99 and ELU to `/metrics` [R] - the posting
  test suggests the loop is near saturation, and this is the metric that would prove it.
- [F] Pino logs every request at `info` (`autoLogging` except `/health`); Drizzle SQL at `trace`
  only. Measure log cost with `LOG_LEVEL=warn` vs `info` in `posting-test.mjs` before changing.
- [F] Scheduled jobs run inside the API process; a slow job and HTTP traffic share one event loop.
  Add a worker mode (`APP_ROLE=api|worker`) so jobs can run in a separate process / replica [R].

---

## 19. Audit logging [M]

Audit insert 0.27-0.47 ms per posting (4.06 vs 4.68 ms per 4-line posting without / with = ~7-13 %
of the DB time, ~1 % of end-to-end). ~519 B per row; 1 row per posting (+ one per workflow step and
one SoD-warning row when approver = poster). Indexes: `(organization_id, occurred_at)`,
`(entity_type, entity_id)`, `(user_id)`, `(correlation_id)`; no serialization (bigserial only).
**Do not reduce it.** Growth [E]: ~2 kB per manually entered journal (4 workflow audit rows); at
10M API-posted journals ≈ 20 GB → plan partitioning by `occurred_at` (append-only; immutability
triggers apply per partition) and retention by legal requirement, not by performance.

---

## 20. Failure and recovery [M]

| Test                                                | Result                                              | Books after (`perf-verify.sql`) |
| --------------------------------------------------- | --------------------------------------------------- | ------------------------------- |
| `kill -9` API with 12 posting transactions open     | all rolled back by Postgres; restart healthy in 7 s | PASS                            |
| Terminate the API's DB connections                  | **API process crashed** (B1)                        | PASS                            |
| Duplicate post x2 / x10 / x100 (no key)             | all 201, one posting, one POST audit                | PASS                            |
| Duplicate post with one `Idempotency-Key`           | 1 x 201, rest 409 `IDEMPOTENCY_IN_PROGRESS`         | PASS                            |
| Duplicate create with body `idempotencyKey`         | one journal; 8 x 500 (B9)                           | PASS                            |
| Duplicate reverse x100                              | 1 reversal, 99 x 422 `JOURNAL_INVALID_STATE`        | PASS                            |
| Deadlock                                            | victim rolled back, HTTP 500 (no retry) (B2)        | PASS                            |
| Redis failure, transaction timeout, network timeout | **not run** - test plan in section 24               | -                               |

---

## 21. Test data - `perf-volume.sql` analysis and the new generator

`perf-volume.sql` [F]: 40,000 GENERAL journals x exactly 2 lines, dates `2026-01-01 + (i*7 % 270)`
(uniform), debit rotating over EXPENSE accounts, credit over `1130, 1180, 2100, 2110, 4100, 4900`
(bank, **AR / AP control**, revenue) - so AR / AP reconciliations and `*_CONTROL_VARIANCE` fail
afterwards; no dimensions, no reversals, no drafts, one company, one year. It is fine for the
2026-09 comparison, but not for correctness testing or for 1M+ volumes (it is a single
transaction and all-uniform, and 2 lines per journal over-states journals per line).

**New: `infrastructure/scripts/perf-ledger.sql`** (validated at 130K and 10M lines):

- Clones ACME's master data into `PERF01..NN` companies (chart, mappings, branches, fiscal
  calendar) with geometric company skew; adds fiscal years as needed; 420 PERF accounts + a heavy
  clearing account, 12 branches, 25 departments, 40 cost centres, 60 projects per company.
- **Account skew**: top 5 % of accounts take 60 % of lines, next 15 % take 30 %, the remaining
  80 % take 10 %; the heavy account is on one side of `heavy_share` of journals.
- **Lines per journal**: 55 % 2, 30 % 3-6, 12 % 7-20, 2.5 % 21-60, 0.5 % 100-300 (mean ≈ 6; payroll /
  depreciation-sized batches included) - chosen from the domain: receipts / payments are 2
  lines, invoices / bills with tax 3-6, allocations and accruals more, pay runs hundreds.
- **Dates**: 2 % monthly growth, December +40 %, month-end bunching (u^0.55), ends on the pinned
  business date so the current month is partial; ADJUSTING journals in the last 3 days of months.
- **Status mix**: 93.5 % posted, 3 % reversed with real REVERSAL mirrors, 2 % draft, 1 % submitted,
  0.5 % approved (their lines must stay out of the ledger and the model).
- **Dimensions**: `correlated` (account → home department / cost centre, how charts are used),
  `random` (worst case for the model), `none` (the old benchmark).
- **Validity**: integer-cent balanced by construction; never touches a mapped / control /
  currency-bound / branch-restricted account; `bulk` mode disables the ledger triggers and rebuilds
  the model with the documented repair function (and measures it), `live` mode posts through the
  status flip.
- Throughput [M]: 1.65M journals / 10M lines in 12 m 54 s bulk + 87 s rebuild (≈ 13K lines/s).

### Proposed datasets

| Set       | Journals  | Lines [E: ×6.1] | DB size [E: measured B/row]     | Companies | Accounts / co. | Months | Heavy account                              | Reversals / adjustments | Load time [E]  |
| --------- | --------- | --------------- | ------------------------------- | --------- | -------------- | ------ | ------------------------------------------ | ----------------------- | -------------- |
| A         | 100K      | 0.6M            | ~0.4 GB                         | 2         | 420            | 21     | ~30K lines                                 | 3 % / ~4 %              | 1 min          |
| B         | 500K      | 3M              | ~1.5 GB                         | 3         | 420            | 33     | ~150K                                      | same                    | 4 min          |
| C         | 1M        | 6M              | ~3 GB                           | 4         | 420            | 33     | ~300K                                      | same                    | 8 min          |
| **(run)** | **1.65M** | **10.0M**       | **4.4 GB [M]**                  | 4         | 420            | 33     | 227K (ACME)                                | 3.1 % / 3.6 %           | **14 min [M]** |
| D         | 5M        | 30M             | ~14 GB                          | 6         | 1,000          | 60     | `only=PERF01 heavy_share=0.9` → ~10M lines | same                    | 45 min         |
| E         | 10M       | 61M             | ~27 GB                          | 8         | 1,000          | 60     | 10M+                                       | same                    | 1.5 h          |
| F         | 50M       | 305M            | ~125 GB (+ audit if API-posted) | 20        | 2,000          | 60     | several 10M+                               | same                    | 7 h            |

Use `years`, `clones`, `journals`, `heavy_share`, `only`, `dims` to shape them; run
`perf-verify.sql` (the gate) after loading and after every test.

---

## 22. Financial correctness tests

`infrastructure/scripts/perf-verify.sql` (read-only; 2 m 13 s at 10M lines) - CRITICAL checks
fail the run: entries balanced (lines and header), ≥ 2 lines, line signs, company consistency,
base currency, period match, no posting after lock, trial balance per company, accounting
equation per company, **model = ledger key by key (uncapped)**, reversal pairs / netting / no
double reversal, duplicate source / idempotency key / document number, JE numbers never above the
counter, POST audit for every API posting since `:since` and no orphan audit, synthetic data never
on a control account. WARNINGS: number gaps (legitimate after deleted drafts / bench runs), open
documents in locked periods, duplicate POST audit rows. `posting-test.mjs` runs it automatically
at the end of every scenario and exits 1 on failure.

---

## 23. Load-test infrastructure

### `load-test.mjs` - analysis [F] and what changed

Before: closed loop (each user fires the next page as soon as the last finishes - measures
capacity, not user behaviour, and hides queueing by slowing arrivals), 6-way concurrency per page
(like a browser), no ramp, no think time, one admin session for all users, percentiles by sorted
index (fine), per-endpoint p50 / p95 / max, errors counted globally, `pg_stat_activity` sampled
through `docker exec`, dashboard list stale (16 calls, fixed date).

**Improved (kept, extended)**: 17 dashboard calls with the computed month-end; `RAMP`,
`THINK_MS`, **open-loop `RATE`** (Poisson arrivals, queueing shows as latency); per-endpoint p99
and errors by status; `PG_LOCAL` sampling without Docker; **CPU split** (machine / API / generator
/ Postgres); `mixed-no-controls` scenario. Still missing [R]: multiple distinct users (needs seeded
users per role), server-side event-loop metrics.

### New tools

| Tool                       | Purpose                                                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/perf-ledger.sql`  | financially valid volume (section 21)                                                                                                                                                                       |
| `scripts/perf-verify.sql`  | the correctness gate (section 22)                                                                                                                                                                           |
| `scripts/perf-explain.sql` | `EXPLAIN (ANALYZE, BUFFERS)` of the ledger / integrity statements in their emitted shape                                                                                                                    |
| `scripts/report-bench.mjs` | sequential latency + payload matrix (windows, partial months, heavy / cold GL, deep pages, integrity)                                                                                                       |
| `scripts/posting-test.mjs` | API posting throughput, duplicates (x2 / x10 / x100 with / without keys), mixed post / reverse / report; gate at the end                                                                                    |
| `scripts/pgbench/*.sql`    | DB-level posting (counter on / off, hot / spread accounts, lines, audit on / off), deadlock probes, candidate trigger                                                                                       |
| `k6/accounting-journey.js` | open-model journey login → dashboard → search → GL → create → post → balance, thresholds, test-company guard, idempotency keys on every write. **Not executed in this audit** (k6 not installed on the VM). |

**k6 vs Node**: keep `load-test.mjs` for local diagnosis (it can read `/proc` and
`pg_stat_activity`), use k6 for arrival-rate scenarios, thresholds and CI trend output. Both hit
the same endpoints; neither needs to replace the other.

---

## 24. Recommended test matrix

Every row ends with `perf-verify.sql` (PASS required) and records p50 / p95 / p99, throughput,
errors by endpoint, CPU split, pool usage, lock waits, deadlocks.

| Test                        | Data                   | Load                                                                 | Duration         | Primary metric                        | Correctness check                          | Status here  |
| --------------------------- | ---------------------- | -------------------------------------------------------------------- | ---------------- | ------------------------------------- | ------------------------------------------ | ------------ |
| Baseline                    | 40K (perf-volume)      | 1 user dashboard                                                     | 5 min            | page p95                              | `/integrity` (AR/AP variance expected)     | [H]          |
| Report matrix               | A, C, 10M, D           | 1 sequential                                                         | 10 min           | per-report p95, bytes                 | gate                                       | 10M ✓        |
| Partial periods             | 10M, D                 | 1                                                                    | 5 min            | day / week / MTD / YTD / edges        | gate                                       | 10M ✓        |
| Heavy account               | D (`only=`, heavy 0.9) | 1 + 10                                                               | 15 min           | GL p95 page 1 / deep, export time     | GL closing = model balance                 | 227K ✓       |
| Dashboard load              | 10M, D                 | 1, 10, 20, 50 closed; RATE 0.5-3 open                                | 10 min each      | page p95 / p99, pages/s               | gate                                       | 1/10/20 ✓    |
| Pool sweep                  | 10M                    | 10 users, pool 5/10/20/40                                            | 5 min each       | pages/s, wait events                  | gate                                       | 10/20/40 ✓   |
| Posting (DB)                | 10M, D                 | pgbench 1/4/16/64, counter on/off, hot/spread, 2-6 and 300 lines     | 15 s-10 min      | tps, lock waits, deadlocks            | gate                                       | ✓            |
| Posting (API)               | 10M, D                 | 1/4/16/32 writers                                                    | 20 s-30 min      | journals/s, create/post p99           | gate                                       | ✓            |
| Posting + reports           | 10M                    | 16 writers + 4 readers (+ dashboard)                                 | 30 min           | posting degradation %                 | gate                                       | ✓ (short)    |
| Idempotency                 | any                    | x2 / x10 / x100 concurrent                                           | -                | outcomes by status                    | one posting / audit                        | ✓            |
| Numbering                   | 10M                    | 100 / 500 / 1000 concurrent creates, 2 companies x 2 years x 3 types | -                | duplicates, gaps, wait                | `DUPLICATE_DOCUMENT_NUMBER`, `JE_NUMBER_*` | 64 ✓         |
| Deadlock probes             | any                    | pgbench pair / inversion                                             | 15 s             | deadlocks                             | gate                                       | ✓            |
| Month-end                   | D                      | ADJUSTING / accrual burst on last 3 days + dashboard                 | 1 h              | p99, deadlocks                        | gate                                       | -            |
| Stress                      | D                      | open-loop RATE stepped until p99 > target                            | until saturation | capacity knee                         | gate                                       | -            |
| Soak                        | D                      | realistic mix, THINK_MS 5000                                         | 8-24 h           | p99 drift, RSS, bloat, autovacuum     | gate hourly                                | -            |
| Failure: API kill / DB kill | 10M                    | 16 writers                                                           | per event        | recovery time, error count            | gate                                       | ✓ (B1 found) |
| Failure: Redis down         | any                    | posting + outbox                                                     | 10 min           | posting unaffected, outbox catches up | gate + outbox pending → 0                  | -            |
| Failure: timeouts           | any                    | `statement_timeout` / `lock_timeout` set low                         | 10 min           | rollback, no partial                  | gate                                       | -            |
| BullMQ                      | any                    | 1K / 10K / 100K enqueued jobs                                        | per size         | queue latency, Redis memory           | job_runs idempotent                        | -            |
| Frontend                    | 10M                    | nav-measure production build                                         | 2 rounds         | hop first / settled                   | -                                          | ✓            |

---

## 25. Performance targets (EXAMPLE starting targets - must be validated against business requirements)

| Operation                          | p50    | p95           | p99    |
| ---------------------------------- | ------ | ------------- | ------ |
| Post journal (single API call)     | 100 ms | 300 ms        | 1 s    |
| Account search / journal search    | 100 ms | 300 ms        | 500 ms |
| General ledger page (any account)  | 200 ms | 500 ms        | 1 s    |
| Trial balance                      | 300 ms | 1 s           | 2 s    |
| Balance sheet / income statement   | 300 ms | 1 s           | 2 s    |
| Dashboard page (all calls settled) | 1 s    | 2 s           | 4 s    |
| Reconciliation summary             | 300 ms | 1 s           | 2 s    |
| Integrity (nightly, per company)   | -      | < 15 min wall | -      |

Establish real SLAs from production: export `http_request_duration_seconds` by route from
`/metrics`, collect a few weeks at month-end and year-end, agree per-route objectives with
finance (close-week expectations differ from daily use), and set error budgets; then encode them as
k6 thresholds.

---

## 26. Scaling roadmap

- **Stage 1 - single PostgreSQL + API + Redis (today).** Fix B1 (crash), B2 (sorted trigger,
  lock order, retry), B9 (duplicate create), `/controls/dashboard` → stored run, statement / lock /
  idle timeouts after B1.
- **Stage 2 - optimise.** B3 (rollup or covering index, measured), B4 (hashable keys, incremental
  integrity, bounded concurrency), B6 (opening from the model, `entry_date` on lines, keyset,
  streamed export), B7 (keyset list, trigram search), B5.1 (late allocation), B8 (outbox), drop the
  redundant index, reconciliation statement consolidation, event-loop metrics. Re-run the matrix.
- **Stage 3 - replicas.** API replicas behind the ingress (the throttler and authorization cache
  are per process: move the throttler to Redis and broadcast authz invalidation, or accept the TTL);
  worker process for BullMQ; a **read replica for statements / exports / integrity** once their CPU
  competes with posting (B5 evidence) - reports then read replica-lag-old data, so show "as of"
  timestamps and keep posting-time validations on the primary.
- **Stage 4 - only if measurements demand it.** Partition `journal_lines` / `audit_logs` by month
  (needs B6's `entry_date`), a reporting database fed from the ledger (derived, proven like the
  model), dedicated analytics. Not justified by anything measured so far.

---

## 27. Implementation roadmap (ordered)

1. `pg` client error listener + backend-termination test (B1).
2. Sorted / aggregated period-balance trigger; auto-reversal number allocated before the status
   flip; one retry on 40P01 / 40001 in the posting transaction boundary (B2).
3. Catch `journal_entries_idempotency_uq` in `createIn` and return the existing entry (B9).
4. `/controls/dashboard` reads the stored integrity run; integrity checks with bounded concurrency
   and hashable dimension keys (B4).
5. GL opening balance from `activity()` (B6.1) - small code change, 60x on heavy accounts.
6. Statement / lock / idle-in-transaction timeouts, `statement_timeout` per role (after 1).
7. Measure and choose B3 (covering index vs rollup) with the pgbench write test and the dashboard
   load test; implement with integrity check + rebuild + e2e.
8. Late JE-number allocation; business decision on gapless JE numbers (B5).
9. `entry_date` on lines + keyset GL + streamed / queued GL export (B6.2-3); keyset journal list +
   trigram search (B7).
10. Outbox dispatch loop with `SKIP LOCKED` (B8); short in-progress lease for idempotency keys.
11. Event-loop / ELU metrics, worker mode, drop redundant index, reconciliation consolidation.
12. Datasets D / E on a production-like host; soak and month-end tests; then decide on Stage 3.

---

## 28. Production readiness checklist

- [ ] API survives a database disconnect / failover (B1 test green)
- [ ] No deadlocks in the posting probes; posting retries 40P01 / 40001 once
- [ ] Duplicate create / post / reverse return 200 / 409 / 422, never 500
- [ ] `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` set per role
- [ ] No live whole-ledger audit on any request path; nightly integrity < 15 min per company
- [ ] Heavy-account GL page p95 < target at the largest expected account; exports streamed / queued
- [ ] Dashboard p95 < target at expected concurrency on production-sized hardware
- [ ] Posting throughput per company ≥ 3x the observed month-end peak, with reports running
- [ ] Outbox lag metric and alert; queue depth alert
- [ ] Postgres config sized for the host (shared_buffers, work_mem per role, parallel workers,
      autovacuum on journal_lines / model / audit), `pg_stat_statements` on, `track_io_timing` on
- [ ] Event-loop lag / ELU, pool wait time, lock waits and deadlocks exported as metrics
- [ ] Backups + restore tested at full size (`docs/operations/backup-restore.md`), model rebuild time known
- [ ] Audit retention and partitioning policy agreed
- [ ] `perf-verify.sql` PASS after every load / failure test on the release candidate

---

## 29. Reproduce

```bash
# throwaway database (never e2e / real): migrate + seed, then
psql "$PERF_DB" -v journals=1600000 -v clones=3 -v years=3 -f infrastructure/scripts/perf-ledger.sql
psql "$PERF_DB" -f infrastructure/scripts/perf-verify.sql                 # the gate
psql "$PERF_DB" -f infrastructure/scripts/perf-explain.sql                # plans (run twice)
DATABASE_URL=$PERF_DB API_PORT=3013 RATE_LIMIT_MAX=1000000 AUTH_LOGIN_RATE_LIMIT=100000 \
  APP_CLOCK_FIXED_DATE=2026-09-18 node apps/api/dist/main.js
PERF_DB=$PERF_DB node infrastructure/scripts/report-bench.mjs http://127.0.0.1:3013/api/v1 3
PG_LOCAL=1 PG_URL=$PERF_DB TODAY=2026-09-18 node infrastructure/scripts/load-test.mjs http://127.0.0.1:3013/api/v1 10 30 dashboard
PERF_DB=$PERF_DB node infrastructure/scripts/posting-test.mjs http://127.0.0.1:3013/api/v1 throughput 16 20
PERF_DB=$PERF_DB node infrastructure/scripts/posting-test.mjs http://127.0.0.1:3013/api/v1 duplicates
psql "$PERF_DB" -v company= -f infrastructure/scripts/pgbench/setup.sql
pgbench -n -f infrastructure/scripts/pgbench/post-event.sql -D balspread=400 -D counter=1 \
  -D minlines=2 -D maxlines=6 -D audit=1 -c 16 -j 4 -T 15 -r --failures-detailed "$PERF_DB"
pgbench -n -f infrastructure/scripts/pgbench/deadlock-pair.sql -c 4 -T 10 --failures-detailed "$PERF_DB"
```
