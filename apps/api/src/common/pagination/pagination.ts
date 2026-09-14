import type { PaginatedResult } from '@accounting/types';
import type { PaginationQuery } from '@accounting/validation';

export function toPaginatedResult<T>(
  items: T[],
  total: number,
  query: Pick<PaginationQuery, 'page' | 'pageSize'>,
): PaginatedResult<T> {
  return {
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export function offsetFor(query: Pick<PaginationQuery, 'page' | 'pageSize'>): number {
  return (query.page - 1) * query.pageSize;
}

import { count, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '@/database/database.types';

/** COUNT(*) with the same predicate as the page query. */
export async function countWhere(
  executor: DbExecutor,
  table: PgTable,
  where: SQL | undefined,
): Promise<number> {
  const [row] = await executor.select({ total: count() }).from(table).where(where);
  return Number(row?.total ?? 0);
}
