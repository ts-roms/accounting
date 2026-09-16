import { and, asc, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '@/database/database.types';
import type { ExportPosition } from './exporter';

/**
 * Shared keyset selection for exporters: rows ordered by (updated_at, id),
 * strictly after the given position, plus one extra row to learn `hasMore`
 * without a count. Only ids come back; the exporter loads the domain view
 * for each so the payload is exactly what the API would return.
 */
export async function selectKeyset(
  executor: DbExecutor,
  table: PgTable,
  columns: { id: PgColumn; updatedAt: PgColumn },
  filters: SQL[],
  after: ExportPosition | null,
  limit: number,
): Promise<{ ids: Array<{ id: string; updatedAt: Date }>; hasMore: boolean }> {
  const where = [...filters];
  if (after)
    where.push(
      sql`(${columns.updatedAt}, ${columns.id}) > (${after.updatedAt}::timestamptz, ${after.id}::uuid)`,
    );
  const rows = (await executor
    .select({ id: columns.id, updatedAt: columns.updatedAt })
    .from(table)
    .where(and(...where))
    .orderBy(asc(columns.updatedAt), asc(columns.id))
    .limit(limit + 1)) as Array<{ id: string; updatedAt: Date }>;
  return { ids: rows.slice(0, limit), hasMore: rows.length > limit };
}
