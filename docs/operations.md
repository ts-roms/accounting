# Operations and reliability (hardening H8)

Phase H8 makes the platform safe to run as more than one API instance and
gives operators one place to see what the background machinery is doing.
Nothing in this phase touches business data: it records job outcomes and
integrity summaries, and composes existing services for everything else.

## Background jobs: the registry

Every scheduled job is registered with `JobRegistryService`
(`modules/jobs/job-registry.service.ts`) and executed through
`execute(name, trigger)`:

1. A `job_runs` row is inserted with `RUNNING`, the trigger (`SCHEDULED`,
   `MANUAL`, `STARTUP`) and the instance id (`hostname:pid`).
2. A **PostgreSQL transaction-level advisory lock** keyed on the job name
   (`pg_try_advisory_xact_lock(hashtext('job:<name>'))`) is taken. If another
   instance holds it the run ends as `SKIPPED_LOCKED` - two API instances
   sharing a database never run the same schedule at once, and a crashed
   instance releases its lock automatically.
3. The job body runs; the row ends `SUCCEEDED` (with the job's return value as
   `result`) or `FAILED` (with the error). Failures notify holders of
   `operations.manage` (`JOB_FAILED`, throttled per job by the notification
   policy) and increment `job_runs_total{status="FAILED"}`.

Jobs stay idempotent on their own; the lock removes concurrency, not the need
for idempotency.

### Registering a job

- Jobs that own their schedule call `registry.scheduleRepeatable({ name,
description, queue, repeat, run })`. `repeat` is `{ pattern }` (cron) or
  `{ every }` (ms) - or `null` when disabled by configuration. One
  registry-owned worker per queue dispatches by job name, which also fixed a
  latent bug: three workers filtering `job.name` on one queue each swallowed
  two thirds of the other jobs' occurrences.
- Jobs on the integration runner (`JobRunnerService.register` +
  `schedule(queue, name, repeat, data, description)`) are wrapped
  automatically: the scheduled occurrence runs through the registry.
- Manual trigger: `POST /operations/jobs/:name/run` (`operations.manage`,
  audited as `JOB_RUN`); 422 `JOB_ALREADY_RUNNING` while another instance
  holds the lock.

Registered jobs: `accounting-schedules`, `ai-anomaly-scan`,
`delegation-expiration`, `depreciation-monthly`, `dispatch-outbox`,
`integration-cleanup`, `integration-health-check`, `integrity-check`,
`oauth-token-refresh`, `payables-sweep`, `receivables-collections-sweep`,
`retry-due`, `session-cleanup`, `stale-jobs-sweep`, `sync-due`.

### Queue isolation

Every BullMQ queue and worker uses the `QUEUE_PREFIX` key prefix (default
`accounting`). Deployments - or developer checkouts - that share one Redis
must use distinct prefixes; otherwise one process consumes another's jobs
against the wrong database. `GET /operations/queues` shows depths, failed
counts and the registered schedulers per queue; the dead letter of a queue is
listed, retried (one or all) or discarded from the console, audited as
`QUEUE_RETRY` / `QUEUE_DISCARD`.

### Self-healing sweep

`stale-jobs-sweep` (every 15 min) marks `FAILED`:

- integration sync jobs `QUEUED` for more than 30 minutes without a worker
  ever starting them (`errorCode STALE`) - such rows otherwise block every
  later manual sync because syncs dedupe on an active queued row;
- `job_runs` left `RUNNING` for more than 6 hours by a **different**
  instance (the owner died mid-run).

## Scheduled integrity checks

`integrity-check` (cron `INTEGRITY_CHECK_CRON`, default 03:45) runs
`IntegrityService.run` - the exact checks behind Accounting → Integrity - for
every active company as of today and stores one `integrity_runs` row per
company (`status`, critical / warning counts, findings as `check / severity /
count`). Any non-OK company notifies holders of `integrity.check`
(`INTEGRITY_ALERT`, deduped per company and status). `POST
/operations/integrity-runs { companyId }` runs one company now. Stored rows
summarise; drill-down always re-runs the live report so a stored row never
becomes "the truth".

## Readiness, draining and shutdown

| Endpoint        | Meaning                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/health/live`  | Process is up (liveness).                                                                                                           |
| `/health`       | Dependencies reachable (database, Redis) - Terminus.                                                                                |
| `/health/ready` | **Readiness**: 200 only when the database answers, the bundled migration journal is fully applied and the instance is not draining. |

On `SIGTERM` (or `app.close()`), `RuntimeStatusService.beforeApplicationShutdown`
flips `draining` first - readiness returns 503 so load balancers stop routing
here - then waits for inline jobs; workers close and the pool ends in the
modules' own destroy hooks. Redis is deliberately not part of readiness: the
API serves requests without queues (schedules pause until Redis returns).

`GET /operations/status` returns the full picture: version, instance,
uptime, draining flag, database latency and pool usage (`total / idle /
waiting`), migrations (`known / applied / pending[]`), Redis latency and key
prefix, storage directory writability, per-queue counts and whether jobs run
inline.

## Metrics

`GET /metrics` exposes Prometheus text (optionally behind `METRICS_TOKEN` as a
bearer token):

- `http_requests_total{method,route,status}` and
  `http_request_duration_seconds` histogram - labelled by the **route
  template** (`/api/v1/journal-entries/:id`), never by raw URL, so ids do not
  explode the label space; health and metrics endpoints are excluded;
- `job_runs_total{job,status}`;
- `queue_jobs{queue,state}` (waiting / active / delayed / failed, collected at
  scrape time);
- `process_uptime_seconds`.

The registry is dependency-free (`modules/operations/metrics.service.ts`).

## UI

Administration → **Operations** (`/admin/operations`): health cards
(overall, database, schema, queues, storage), Jobs (schedule, last run,
failing streak, Run now), Run history (filter by job / outcome), Queues (per
queue counts, dead letter with retry / discard) and Integrity runs (per
company, Run now).

## Permissions

| Permission          | Purpose                                                  | System roles                        |
| ------------------- | -------------------------------------------------------- | ----------------------------------- |
| `operations.view`   | Console, status, jobs, runs, queues, integrity runs      | ACCOUNTING_ADMIN, AUDITOR (+ SUPER) |
| `operations.manage` | Run jobs, retry / discard failed jobs, run integrity now | ACCOUNTING_ADMIN (+ SUPER)          |

`operations.view` is a restricted view (like `audit.view`): viewers do not
get it.

## Configuration

| Variable                  | Default      | Purpose                                                        |
| ------------------------- | ------------ | -------------------------------------------------------------- |
| `QUEUE_PREFIX`            | `accounting` | BullMQ key prefix; one per deployment / checkout sharing Redis |
| `INTEGRITY_CHECK_CRON`    | `45 3 * * *` | Nightly integrity job; empty disables                          |
| `METRICS_TOKEN`           | unset        | Bearer token required by `GET /metrics` when set               |
| `INTEGRATION_INLINE_JOBS` | `false`      | Run jobs inline (tests / Redis-less dev); schedulers off       |

## Limitations

- Advisory locks serialise per database; instances on different databases
  are independent by design.
- The stale sweep's thresholds (30 min queued, 6 h running) are constants,
  not policies.
- Metrics are per instance (no aggregation); scrape every instance.
- Backups and restore drills remain an infrastructure concern
  (`docs/deployment.md`); the console reports schema currency, not backup
  age.
