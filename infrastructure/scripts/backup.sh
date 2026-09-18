#!/usr/bin/env bash
# Consistent backup of one accounting deployment: the PostgreSQL database
# (pg_dump custom format, restorable with pg_restore) and the attachment files
# under STORAGE_DIR (tar.gz). Redis is deliberately not backed up: it holds
# queues and schedules that the API recreates on boot (docs/operations/backup-restore.md).
#
#   DATABASE_URL=postgres://... STORAGE_DIR=./storage ./infrastructure/scripts/backup.sh [out-dir]
#
# Needs pg_dump (same major version as the server) and tar on PATH. Exits
# non-zero when any step fails; a partial backup directory is removed.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
STORAGE_DIR="${STORAGE_DIR:-./storage}"
OUT_ROOT="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/$STAMP"
mkdir -p "$OUT"
trap 'echo "backup failed, removing $OUT" >&2; rm -rf "$OUT"' ERR

echo "==> database -> $OUT/database.dump"
# --no-owner/--no-privileges: restorable into a database owned by another role
# (managed PostgreSQL). Custom format is compressed and lets pg_restore run in
# parallel and pick objects.
pg_dump --format=custom --compress=6 --no-owner --no-privileges \
  --file "$OUT/database.dump" "$DATABASE_URL"

echo "==> migration state -> $OUT/migrations.txt"
psql "$DATABASE_URL" --tuples-only --no-align \
  --command "select id, hash, created_at from drizzle.__drizzle_migrations order by id" \
  > "$OUT/migrations.txt"

if [ -d "$STORAGE_DIR" ]; then
  echo "==> attachments ($STORAGE_DIR) -> $OUT/storage.tar.gz"
  tar -C "$STORAGE_DIR" -czf "$OUT/storage.tar.gz" .
else
  echo "==> no storage directory at $STORAGE_DIR (skipping attachments)"
fi

(cd "$OUT" && sha256sum -- * > SHA256SUMS)
echo "==> done: $OUT"
ls -la "$OUT"
