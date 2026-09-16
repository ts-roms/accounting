# Deployment

## Local development

```bash
cp .env.example .env            # adjust secrets; JWT_ACCESS_SECRET >= 32 chars
pnpm install
pnpm infra:up                   # PostgreSQL (host port 5433) + Redis (6379) in Docker
pnpm build:packages             # compile shared packages (also done by `pnpm build`)
pnpm db:migrate && pnpm db:seed
pnpm dev                        # turbo: packages in watch mode + API (3001) + web (3000)
```

Or: `bash infrastructure/scripts/dev-setup.sh`.

Seeded accounts (development only): `admin@acme.local / Admin!Passw0rd`
(SUPER_ADMIN), `accountant@`, `finance@`, `auditor@`, `viewer@acme.local` with
`Demo!Passw0rd`.

Note: PostgreSQL is published on **5433** to coexist with a locally installed
PostgreSQL on 5432; change `POSTGRES_HOST_PORT` / `DATABASE_URL` if needed.

## Containers

`infrastructure/docker/docker-compose.yml` defines:

- `postgres`, `redis` - always started (`pnpm infra:up`).
- `api`, `web` - profile `app`, multi-stage Dockerfiles
  (`api.Dockerfile`, `web.Dockerfile`), non-root runtime users.

```bash
docker compose -f infrastructure/docker/docker-compose.yml --profile app up --build
```

The API container does not auto-migrate on boot; run migrations as an explicit
deployment step (`pnpm db:migrate` from CI or a one-off container) so schema
changes stay deliberate and auditable.

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

## CI (recommended pipeline)

1. `pnpm install --frozen-lockfile`
2. `pnpm build` (packages first via turbo)
3. `pnpm lint && pnpm typecheck && pnpm test`
4. Start PostgreSQL/Redis services, `pnpm --filter @accounting/api test:e2e`
5. Build images, run Playwright against the composed stack
   (`pnpm --filter @accounting/web test:e2e`)
