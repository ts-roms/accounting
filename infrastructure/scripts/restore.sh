#!/usr/bin/env bash
# Restore a backup made by backup.sh into an EMPTY database (and an empty
# storage directory). Refuses to touch a database that already has tables so a
# typo cannot overwrite production; drop and recreate the database first when
# you really mean it (docs/operations/backup-restore.md).
#
#   DATABASE_URL=postgres://... STORAGE_DIR=./storage ./infrastructure/scripts/restore.sh backups/20260919T010000Z
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
STORAGE_DIR="${STORAGE_DIR:-./storage}"
SRC="${1:?backup directory is required}"
[ -f "$SRC/database.dump" ] || { echo "no database.dump in $SRC" >&2; exit 1; }

echo "==> verifying checksums"
(cd "$SRC" && sha256sum --check --quiet SHA256SUMS)

TABLES="$(psql "$DATABASE_URL" --tuples-only --no-align \
  --command "select count(*) from information_schema.tables where table_schema = 'public'")"
if [ "$TABLES" != "0" ]; then
  echo "target database already has $TABLES tables in schema public; restore only into an empty database" >&2
  exit 1
fi

echo "==> restoring database"
# --single-transaction: all or nothing. Extensions (pg_stat_statements) are
# recreated when the role may; otherwise the migration is a no-op and the ops
# console reports the extension as unavailable.
pg_restore --no-owner --no-privileges --single-transaction --exit-on-error \
  --dbname "$DATABASE_URL" "$SRC/database.dump"

if [ -f "$SRC/storage.tar.gz" ]; then
  if [ -d "$STORAGE_DIR" ] && [ -n "$(ls -A "$STORAGE_DIR" 2>/dev/null)" ]; then
    echo "storage directory $STORAGE_DIR is not empty; move it aside first" >&2
    exit 1
  fi
  echo "==> restoring attachments into $STORAGE_DIR"
  mkdir -p "$STORAGE_DIR"
  tar -C "$STORAGE_DIR" -xzf "$SRC/storage.tar.gz"
fi

echo "==> restored. Next: run migrations (pnpm db:migrate) if the code is newer than the backup,"
echo "    start the API, check /api/v1/health/ready, then POST /api/v1/integrity/runs per company."
