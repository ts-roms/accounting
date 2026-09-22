# Deployment

## Local development

```bash
cp .env.example .env            # adjust secrets; JWT_ACCESS_SECRET >= 32 chars
pnpm install
pnpm infra:up                   # PostgreSQL (host port 5433) + Redis (6379) in Docker
pnpm build:packages             # compile shared packages (also done by `pnpm build`)
pnpm db:migrate && pnpm db:seed
pnpm dev                        # builds the packages, then runs everything in parallel:
                                #   package watchers + API (3001) + web (3006), output prefixed per app
pnpm dev:apps                   # only the two apps, in parallel (packages built once, no watchers)
```

Or: `bash infrastructure/scripts/dev-setup.sh`. `pnpm start` runs the built API and
web (`pnpm build` first) in parallel the same way; `pnpm dev:api` / `pnpm dev:web`
start one app.

Seeded accounts (development only): `admin@acme.local / P@ssw0rd123`
(SUPER_ADMIN), `accountant@`, `finance@`, `auditor@`, `viewer@acme.local` with
`P@ssw0rd123`.

Note: PostgreSQL is published on **5433** to coexist with a locally installed
PostgreSQL on 5432; change `POSTGRES_HOST_PORT` / `DATABASE_URL` if needed.

## Containers

`infrastructure/docker/docker-compose.yml` defines:

- `postgres`, `redis` - always started (`pnpm infra:up`). Postgres gets
  `shm_size: 256m`: parallel workers and hash aggregates allocate dynamic
  shared memory, and Docker's 64 MB default fails under ~20 concurrent report
  queries (`could not resize shared memory segment` -> HTTP 500). Recreate the
  container (`docker compose up -d postgres`) after pulling this change.
- `api`, `web` - profile `app`, multi-stage Dockerfiles
  (`api.Dockerfile`, `web.Dockerfile`), non-root runtime users.

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile app up --build
```

The API process never migrates on boot. Migrate-on-deploy is the `migrate`
service in the compose file: the same API image runs the bundled migrations
(`node dist/database/migrate.js`, also `pnpm --filter @accounting/api
db:migrate:dist`) and exits, and `api` starts only after it succeeded
(`depends_on: condition: service_completed_successfully`). A failed migration
stops the rollout with its log instead of booting an API whose readiness would
fail. On other platforms run the same command as a pre-deploy job / init
container; `/health/ready` stays 503 until every bundled migration is applied.

The compose Postgres preloads `pg_stat_statements` (`shared_preload_libraries`)
and `postgres/init/02-extensions.sql` creates it; migration
`0038_pg_stat_statements` also tries `CREATE EXTENSION` on every database and
only notices when it cannot. Administration -> Operations -> **Statements**
reads it. Recreate a Postgres container created before this change
(`docker compose up -d postgres`) - the data volume is kept.

Backups: `docs/operations/backup-restore.md` (`infrastructure/scripts/backup.sh`
/ `restore.sh`, what holds state, the restore drill).

## Environment

See `.env.example`. Production requirements:

- `NODE_ENV=production`, `COOKIE_SECURE=true`, HTTPS termination in front of
  Next.js, `API_CORS_ORIGINS` restricted to the web origin.
- `API_INTERNAL_URL` points the Next.js server at the API service over a private
  network; the API need not be publicly reachable.
- Managed PostgreSQL with point-in-time recovery; Redis with persistence
  (queues hold scheduled financial jobs).
- `STORAGE_DIR` on a persistent, backed-up volume (attachments are stored on
  disk; only their metadata and sha256 live in PostgreSQL).
- `AI_PROVIDER`: `HEURISTIC` needs nothing and stays offline; `ANTHROPIC` needs
  `ANTHROPIC_API_KEY` (and optionally `AI_MODEL`) and sends document text /
  images and verified report facts to the Anthropic API - review your data
  policy before enabling it. `AI_ANOMALY_SCAN_DAYS=0` disables the nightly scan.
- Log shipping of the JSON logs (correlation ids link web, API and DB events).
- `APP_CLOCK_FIXED_DATE` stays **unset** in production. It pins the business
  calendar date (`businessToday()`: default as-of dates, scheduled jobs, document
  numbering years) for demo and test stacks - CI sets `2026-09-18`, the seed's
  date, so seeded invoices never age into dunning credit holds or new aging
  buckets and the Playwright suite stays deterministic. Wall-clock timestamps
  (audit, sessions) are never pinned.

## Health & observability

- `GET /api/v1/health/live` for liveness, `/health/ready` for readiness
  (200 only when the database answers, every bundled migration is applied and
  the instance is not draining - wire this one into the load balancer),
  `/health` for dependency detail (DB + Redis).
- Graceful shutdown: on SIGTERM readiness flips to 503 first, inline jobs
  drain, then workers and the pool close (`docs/operations.md`).
- Structured logs via pino; every response carries `x-correlation-id`.
- `GET /api/v1/metrics` - Prometheus text (request counts / latency per route
  template, job runs, queue depths); set `METRICS_TOKEN` to require a bearer
  token. Scrape every instance.
- Run more than one API instance freely: scheduled jobs are serialised with
  PostgreSQL advisory locks and every deployment sharing a Redis needs its own
  `QUEUE_PREFIX`. Administration → Operations shows jobs, dead letters and
  the nightly integrity outcomes.
- Error tracking (e.g. Sentry) remains a planned logger transport.

## CI (`.github/workflows/ci.yml`)

Runs on every pull request and on pushes to `main`; the whole run is the
same set of commands you run locally.

| Job       | What it does                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality` | `pnpm install --frozen-lockfile`, `pnpm build` (packages, API, web), `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`.                                                                                                                                                                                                                                          |
| `api-e2e` | PostgreSQL 16 + Redis 7 service containers; `pnpm --filter @accounting/api test:e2e` (every suite drops and reseeds `accounting_test`).                                                                                                                                                                                                                                        |
| `web-e2e` | Service containers, `pnpm build`, `pnpm db:migrate && pnpm db:seed` into `accounting_ci`, the API from `dist/main.js` on 3001, `next start` on 3000 (the standalone output is not used in CI: artifact uploads flatten pnpm's symlinks), `playwright install --with-deps chromium`, `playwright test`. The HTML report, traces and both server logs are uploaded on every run. |

Test-only secrets (`JWT_ACCESS_SECRET`, `INTEGRATION_ENCRYPTION_KEY`) are
literals in the workflow; the seeded password is `P@ssw0rd123`. Services are
addressed as `127.0.0.1` - see the note in `.env.example`.

Running the same pipeline locally:

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
pnpm --filter @accounting/api test:e2e          # needs Docker infra; per-worktree test database
pnpm --filter @accounting/web test:e2e          # against a running, seeded stack (PLAYWRIGHT_BASE_URL)
```

On Windows the standalone server refuses to start from a pnpm workspace
(`EPERM` on the symlinked `node_modules`); use `next start` (or `next dev`)
for a local Playwright run - the standalone path is exercised on Linux in CI.
