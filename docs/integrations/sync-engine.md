# Synchronisation engine

`POST /api/v1/integrations/:id/sync` creates a row in `integration_sync_jobs`
(`QUEUED`) and enqueues `run-sync` on the `integration-sync` queue. The HTTP
request returns the job (`202`); the UI polls `GET /integrations/:id/sync-jobs`.

```
QUEUED -> RUNNING -> COMPLETED
                  -> FAILED   (errorCode / errorMessage; auto-retry for transient codes)
                  -> PAUSED   (cancel requested while running; resumable)
QUEUED -> CANCELLED
```

## Run loop (`sync/sync-engine.ts`, pure)

For each entity the connector supports (or the one requested):

1. Start from the job's `startCursor`, else the stored cursor
   (`integration_sync_cursors`) for INCREMENTAL, else nothing for FULL.
2. `connector.pull({ entity, cursor, limit: 100, mode })`.
3. For every record: mapping -> importer (each record in its own domain
   transaction, so one bad record fails alone).
4. After every page: persist `lastCursor` on the job and the entity cursor.
   This is the checkpoint - a run that dies at record 4,521 resumes from the
   last committed page, and the overlap is idempotent because importers look
   up `integration_external_references` before creating anything.
5. Transport-level errors (timeout, network, 429, 401) abort the run and are
   retried as a whole; record-level errors are counted and listed in
   `failures` (bounded to 100). More than 50 % failures after 20 records stops
   the run.

Counters kept on the job: processed / created / updated / skipped / failed,
start / finish time, duration, start / last / next cursor.

## Modes and triggers

| Mode          | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `INCREMENTAL` | Continue from the stored cursor (provider `updated_at`, page token) |
| `FULL`        | Ignore the cursor; existing records are updated, not duplicated     |

| Trigger     | Origin                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| `MANUAL`    | `POST /integrations/:id/sync`                                           |
| `SCHEDULED` | `syncSchedule` cron (5-field) evaluated every minute by `sync-due`      |
| `RETRY`     | Automatic re-queue after a transient failure (max 3, backoff)           |
| `RESUME`    | `POST /integrations/:id/sync` with `resumeJobId` of a failed/paused job |
| `WEBHOOK`   | A connector asked for a sync after an inbound event                     |

Only one job per integration may be queued or running (`422 SYNC_IN_PROGRESS`).

## Importers (`sync/importers/`)

| Entity              | Domain service                               | Notes                                                                                                                                                              |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `customers`         | `CustomersService.create/update`             | Matches by external reference, then by customer code                                                                                                               |
| `invoices`          | `InvoicesService.create` (+approve/post)     | Always DRAFT; approve + post only with `invoices:post` and `config.autoPost`                                                                                       |
| `payments`          | `CustomerPaymentsService.create` (+post)     | Cash account from `config.cashAccountId`; allocates to the referenced invoice when open                                                                            |
| `bank-transactions` | `StatementsService.import`                   | A statement with lines; reconciliation happens in banking, never a journal                                                                                         |
| `vendors`           | `VendorsService.create/update`               | Matches by external reference, then by vendor code                                                                                                                 |
| `bills`             | `BillsService.create` (+approve/post)        | Always DRAFT; expense account = line / `config.expenseAccountId` / vendor default / `DEFAULT_EXPENSE`; approve + post only with `bills:post` and `config.autoPost` |
| `products`          | `CatalogService.createProduct/updateProduct` | Matches by external reference, then by SKU; never moves stock                                                                                                      |
| `sales-orders`      | `OrdersService.create` (+submit)             | Always DRAFT; `config.autoSubmit` submits it (credit policy + approval workflow), never approves; product / revenue account from line, product default or `config` |

Importers enforce the integration's scopes explicitly (`assertScope`) because
jobs do not pass through the HTTP guards, and they run inside a
`RequestContext` carrying the integration principal so audit rows attribute
the change to the integration's owner with the job's correlation id.

## Outbound push (`sync/push-engine.ts`, pure)

The mirror of the pull loop, for providers with the `PUSH` capability
(e-invoicing authorities, CRMs, supplier portals). Same job rows, cursors,
retries, cancel / resume, audit and logs - `integration_sync_jobs.direction`
and `integration_sync_cursors.direction` say which way a run went.

```
POST /integrations/:id/push { entity?, mode?, resumeJobId? }   -> job (202)

for entity of (job.entity ?? connector.entities):
  position = FULL ? null : stored outbound cursor            # keyset {updatedAt, id}
  loop:
    page     = exporter.select(ctx, { after: position, limit })   # domain views, (updatedAt, id) order
    prior    = external references of the page (by internal id)
    batch    = for each record:
                 INCREMENTAL and prior.pushedAt >= updatedAt -> skipped (unchanged)
                 outbound mapping (connector default / integration / pass-through)
                 mapping error -> failed (record level)
    answers  = connector.push(ctx, { entity, records: batch })   # externalId of an earlier push is passed back
    per answer: ok -> linkByInternal(externalId, { pushedAt, label, ...metadata })  created / updated
                !ok -> failed (VALIDATION_ERROR, provider message)
    checkpoint(position of last record)                            # resume point
```

- **Exporters** (`sync/exporters/`) only read: `customers`, `vendors`,
  `products` (every record, with status) and `invoices`, `bills` (only
  documents that left `UNPOSTED`, with lines, tax and allocations - drafts never
  leave the books). Payload = the API view, so a provider only ever receives what
  the ledger says. Each exporter asserts the matching read scope
  (`invoice.view`, ...); without it the run fails with `AUTHORIZATION_ERROR`.
- **Mapping direction**: `OUTBOUND` mappings turn the view into the provider's
  payload (`descriptor.defaultOutboundMappings`, overridable per integration);
  with no rules at all the view is passed through unchanged.
- **Idempotency**: the external reference is keyed by internal id
  (`linkByInternal`) and remembers `pushedAt`; an incremental push re-sends a
  record only when it changed since, a `FULL` push re-sends everything and
  hands the provider the earlier `externalId` so it can update instead of
  create. Transport errors abort the run at the last checkpoint and are retried
  like a pull; a provider rejection is a per-record failure listed on the job.
- **Schedules** pull when the connector can and push otherwise, so a push-only
  provider runs on its cron like any other.
- Nothing here writes to the domain: a push cannot post, approve or change a
  document - it can only tell a provider what already happened.
