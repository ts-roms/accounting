# Integration platform - architecture

Source: `apps/api/src/modules/integrations/` (platform) and
`apps/api/src/modules/delegations/` (delegated authority). Both are modules of
the modular monolith; nothing runs as a separate service.

## Principle

The integration layer is an **adapter, not an accounting engine**. An external
system can create customers, draft invoices, record receipts or import bank
statements, but every ledger effect goes through the same domain services and
the same posting engine as a manual entry:

```
External System
      |
Connector (IntegrationConnector)         verifyWebhook / pull / push / OAuth
      |
Authentication / signature verification  API key, HMAC, OAuth 2.0, Bearer
      |
Rate limit / idempotency                 per-key quota, Idempotency-Key, event ids
      |
Validation + Mapping                     mapping.logic.ts (pure), Zod schemas
      |
Importer (adapter)                       CustomersImporter, InvoicesImporter, ...
      |
Domain service                           CustomersService, InvoicesService, StatementsService
      |
AccountingPostingService                 the only writer of journal_entries / journal_lines
      |
General ledger
```

There is no endpoint that accepts journal lines from an integration. API keys
with `journals:create` can draft a journal; posting needs a person with
`journal.post` (`test/integrations.e2e-spec.ts`, "accounting safety").

## Components

| Directory        | Responsibility                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `core/`          | Connector contract, registry, integration registry service, encrypted credentials, provider HTTP |
| `connectors/`    | One class per provider (demo bank, payment gateway, e-commerce, tax authority, OAuth CRM)        |
| `api-keys/`      | Internal API keys, scopes, rotation, per-key rate limit                                          |
| `oauth/`         | Authorisation-code + PKCE flow, state, refresh, revoke                                           |
| `webhooks/`      | Inbound receiver (signature, dedupe, async processing) and outbound subscriptions / deliveries   |
| `events/`        | Transactional outbox (`OutboxService`, global module)                                            |
| `sync/`          | Sync jobs, pull -> map -> import engine, cursors, scheduling, retries; importers per entity      |
| `mapping/`       | Pure field-mapping engine, per-integration mapping storage, external references                  |
| `retries/`       | Retry policy by error code (pure)                                                                |
| `idempotency/`   | `Idempotency-Key` interceptor and storage                                                        |
| `logs/`          | Redacted integration log (DB + structured pino line)                                             |
| `health/`        | Measured health score (pure `health.logic.ts`) and the periodic check                            |
| `notifications/` | In-app notifications with per-organization policies (global module)                              |
| `jobs/`          | Cleanup job (the generic `JobRunnerService` lives in `modules/jobs`)                             |

## Boundaries

- `IntegrationsModule` depends on domain modules (`ReceivablesModule`,
  `BankingModule`, `AccountingModule`) through their exported services only.
- No domain module depends on `IntegrationsModule`. Domain services write
  outbox rows through the **global** `OutboxModule`; approval-type services
  consult `DelegationsModule` (which depends on RBAC and jobs only).
- `AuthModule` imports `ApiKeysModule` and `DelegationsModule` so the guard can
  authenticate keys and attach delegated grants; neither imports `AuthModule`.

## Background work

BullMQ queues (`modules/jobs/queue.service.ts`): `integration-sync`,
`webhook-delivery`, `webhook-inbound`, `integration-maintenance`. Workers are
registered through `JobRunnerService`; with `INTEGRATION_INLINE_JOBS=true`
(always in tests) handlers run in-process with identical semantics, so the e2e
suites exercise the real sync / delivery code without Redis. Every handler is
idempotent: sync jobs are keyed by row status, deliveries by delivery row,
inbound events by provider event id.

| Job                        | Queue                   | Cadence          |
| -------------------------- | ----------------------- | ---------------- |
| `run-sync`                 | integration-sync        | on demand        |
| `sync-due`                 | integration-maintenance | every minute     |
| `process-inbound`          | webhook-inbound         | on receipt       |
| `dispatch-outbox`          | webhook-delivery        | on commit + 30 s |
| `deliver` / `retry-due`    | webhook-delivery        | on demand / 15 s |
| `oauth-token-refresh`      | integration-maintenance | every 5 min      |
| `integration-health-check` | integration-maintenance | every 10 min     |
| `delegation-expiration`    | integration-maintenance | every 5 min      |
| `integration-cleanup`      | integration-maintenance | 03:30 daily      |

Every scheduled job above goes through the H8 job registry
(`JobRunnerService.schedule` registers it): one advisory lock per name, a
`job_runs` row per occurrence, visible and triggerable from the operations
console.

### Operations (`ops/`)

- **Dead letters** - `GET /integrations/ops/dead-letters` is one queue for
  everything the platform gave up on: EXHAUSTED outbound deliveries that no
  replay picked up, FAILED inbound events, FAILED outbox rows and FAILED sync /
  push jobs nobody resumed. `replay` hands each kind to its own idempotent
  path (delivery replay row, inbound re-processing, outbox re-dispatch, sync
  resume from the checkpoint), `replay-all` does it per kind, `discard` marks
  the row acknowledged (delivery DISABLED, event REJECTED, job CANCELLED) so it
  leaves the queue but stays as history. Every action is audited
  (`DeadLetter`). Administration -> Integrations -> Operations shows the queue
  and the retention policy; each integration's Health tab counts its own dead
  letters.
- **Retention** - the nightly cleanup applies
  `INTEGRATION_LOG_RETENTION_DAYS` (90), `INTEGRATION_EVENT_RETENTION_DAYS`
  (30), `WEBHOOK_DELIVERY_RETENTION_DAYS` (30) and `SYNC_JOB_RETENTION_DAYS`
  (180) in bounded batches of 5 000 rows: terminal rows go after their window,
  dead letters after twice the window, and an outbox row is never removed while
  a delivery still references it (deliveries are compacted first).
  `GET /integrations/ops/retention` returns the effective policy.
- **Metrics** - `GET /integrations/:id/health` carries a `metrics` block for
  the last 24 h next to the score: provider calls, failures and error rate,
  average and p95 latency, sync / push jobs and records, webhook deliveries,
  dead letters.

## Tenancy

Every table carries `organization_id` (and `company_id` where the data is
company-bound). Registry, keys, webhooks and delegations are filtered by the
principal's organization on every query; the inbound webhook receiver looks an
integration up by id but authenticates with that integration's own secret.

## Tables (migration `0015_integrations_delegations`)

`integrations`, `integration_credentials`, `integration_scopes`,
`integration_sync_jobs`, `integration_sync_cursors`, `integration_mappings`,
`integration_external_references`, `integration_logs`, `integration_events`
(outbox + inbound), `integration_webhooks`, `integration_webhook_deliveries`,
`oauth_connections`, `api_keys`, `api_key_scopes`, `idempotency_keys`,
`notifications`, `notification_policies`, `delegations`, `delegation_scopes`,
`delegation_approvals`, `delegation_usage`, `delegation_policies`.
