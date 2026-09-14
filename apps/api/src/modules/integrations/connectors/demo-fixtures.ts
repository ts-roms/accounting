import type { ExternalRecord, PullResult } from '../core/connector';

/**
 * Shared helpers for the demo connectors. Their "provider" is the
 * integration's own config (`config.fixture`), which lets tests and demos
 * drive deterministic data through the real pipeline without a network.
 */

/** Cursor = number of records already delivered (as a string), so resume is trivial to reason about. */
export function pageFromFixture(
  records: ExternalRecord[],
  cursor: string | null | undefined,
  limit: number,
): PullResult {
  const offset = cursor ? Number(cursor) || 0 : 0;
  const slice = records.slice(offset, offset + limit);
  const next = offset + slice.length;
  const hasMore = next < records.length;
  return {
    records: slice,
    nextCursor: hasMore ? String(next) : records.length ? String(next) : null,
    hasMore,
  };
}

export function fixtureArray(
  config: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> {
  const fixture = (config.fixture ?? {}) as Record<string, unknown>;
  const value = fixture[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

export function toRecords(rows: Array<Record<string, unknown>>, idField = 'id'): ExternalRecord[] {
  return rows.map((row) => ({
    externalId: String(row[idField] ?? ''),
    data: row,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : undefined,
  }));
}

/** Demo secrets are validated by shape only; they are never real credentials. */
export function looksLikeDemoSecret(value: string | undefined, prefix: string): boolean {
  return typeof value === 'string' && value.startsWith(prefix) && value.length >= prefix.length + 4;
}
