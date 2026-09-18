# Backup and restore runbook

What a deployment must keep, how to take a consistent copy of it, how to put
it back, and how to prove the books are whole afterwards. Scripts:
`infrastructure/scripts/backup.sh` and `restore.sh`.

## What holds state

| Store                         | Contents                                                                                                                    | Loss means                                                                                   | Back up?                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| PostgreSQL (`DATABASE_URL`)   | Everything financial: ledger, subledgers, documents, audit trail, users, workflow requests, job runs, notification policies | The books                                                                                    | **Yes** - `pg_dump` + point-in-time recovery                                  |
| `STORAGE_DIR` on disk         | Attachment bytes; their metadata and sha256 live in PostgreSQL                                                              | Attachments open as missing files; nothing financial changes                                 | **Yes** - file copy, same cadence as the database                             |
| Redis (`REDIS_URL`)           | BullMQ queues, repeatable schedules, dead letters                                                                           | Schedules are re-registered on API boot; a job that was queued at the moment is re-run later | No (persistence on for crash recovery only)                                   |
| Environment (`.env`, secrets) | JWT secrets, `INTEGRATION_ENCRYPTION_KEY`, provider credentials                                                             | Sessions invalid; **encrypted integration credentials become unreadable**                    | **Yes** - in the secret store, never inside the database backup               |
| `packages`/`dist` migrations  | Schema journal shipped with the code                                                                                        | -                                                                                            | Comes with the release; note the git SHA with every backup (`migrations.txt`) |

The derived tables (`account_period_balances`) are inside PostgreSQL and
restore with it; if a restore ever bypasses the triggers (manual copies, partial
restores) run `POST /operations/period-balances/rebuild` per company.

## Taking a backup

```bash
DATABASE_URL=postgres://accounting:...@host:5432/accounting \
STORAGE_DIR=/srv/accounting/storage \
./infrastructure/scripts/backup.sh /srv/backups
```

Produces `/srv/backups/<UTC stamp>/` with:

- `database.dump` - `pg_dump --format=custom --no-owner --no-privileges`
  (compressed; restorable with `pg_restore`, in parallel, into a database owned
  by any role);
- `migrations.txt` - the applied migration rows, so the backup can be matched
  to a code version;
- `storage.tar.gz` - the attachment files;
- `SHA256SUMS` - verified by `restore.sh` before it touches anything.

`pg_dump` takes a consistent snapshot (one transaction), so posting can
continue during the backup. Take the file copy right after the dump; an
attachment uploaded between the two shows up as metadata without a file, which
`AttachmentsService` reports as missing rather than failing the document.

**Cadence.** Nightly full dump plus the provider's point-in-time recovery
(WAL archiving) on managed PostgreSQL, which brings the recovery point down
to minutes. Keep at least 30 daily dumps and every month-end / year-end
(period-close) dump for as long as the retention policy requires - closed
periods are locked in the ledger, but auditors ask for the dump.

**Local / compose.** The compose Postgres runs in the container, so run the
script through it:

```bash
docker exec accounting-postgres pg_dump -U accounting --format=custom accounting > backups/local.dump
```

## Restoring

1. **Provision an empty database** (new database on the same server, or a new
   instance). `restore.sh` refuses a database that already has tables in
   `public`: dropping production by mistake is the failure mode this guards
   against. To replace a broken database on purpose, drop and recreate it
   explicitly first.
2. **Restore**:

   ```bash
   DATABASE_URL=postgres://accounting:...@host:5432/accounting_restored \
   STORAGE_DIR=/srv/accounting/storage-restored \
   ./infrastructure/scripts/restore.sh /srv/backups/20260919T010000Z
   ```

   `pg_restore --single-transaction --exit-on-error`: all or nothing.

3. **Bring the schema up to the running code** when the backup predates it:
   `pnpm db:migrate` (or `pnpm --filter @accounting/api db:migrate:dist` from
   the built image). In compose the `migrate` service does this before the API
   starts.
4. **Point the API at it** (`DATABASE_URL`, `STORAGE_DIR`) and start it.
   `GET /api/v1/health/ready` must return 200 (schema current, not draining).
5. **Prove the books** - for every company, `POST /api/v1/integrity/runs`
   (or Administration -> Operations -> Integrity runs -> Run now) and expect
   `OK`. The 23 checks cover balanced journals, subledger = control account,
   period balances = lines, statements tying, and the rest of
   `docs/accounting-controls.md`. A `CRITICAL` outcome after a restore means
   the copy is inconsistent; do not open it to users.
6. **Rotate anything the restore invalidates**: refresh tokens are in the
   database and were valid at backup time - they still are; if the restore
   is because of a compromise, rotate `JWT_*` secrets so every session ends.
7. **Redis**: nothing to restore. On boot the API re-registers every
   repeatable job (`JobRegistryService`); the stale-jobs sweep clears run rows
   the old instance left `RUNNING`. Use a fresh `QUEUE_PREFIX` when the old
   Redis is still alive so the two deployments do not share queues.

## Drill

Quarterly, restore the latest backup into a scratch database and run steps
3-5 against it; record the wall-clock time (that is the RTO) and the backup's
stamp versus "now" (the RPO). The compose stack is enough for the drill:

```bash
docker exec accounting-postgres createdb -U accounting accounting_drill
DATABASE_URL=postgres://accounting:accounting@127.0.0.1:5433/accounting_drill ./infrastructure/scripts/restore.sh backups/<stamp>
DATABASE_URL=postgres://accounting:accounting@127.0.0.1:5433/accounting_drill pnpm db:migrate
```

Then start an API against `accounting_drill` (`API_PORT=3011`, its own
`QUEUE_PREFIX`) and run the integrity checks.

## What is not covered

- Cross-region replication and encryption at rest are the database
  provider's features; enable both.
- `pg_dump` of a very large ledger takes minutes; the trigger-maintained
  period balances are in the dump, so restores do not need a rebuild unless
  the dump was taken with `--exclude-table`.
- The console reports schema currency, not backup age; wire the backup job's
  success into the same alerting as `JOB_FAILED` notifications.
