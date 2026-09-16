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
