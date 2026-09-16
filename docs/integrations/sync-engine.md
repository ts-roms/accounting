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

Importers enforce the integration's scopes explicitly (`assertScope`) because
jobs do not pass through the HTTP guards, and they run inside a
`RequestContext` carrying the integration principal so audit rows attribute
the change to the integration's owner with the job's correlation id.
