import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type {
  IntegrationDirection,
  IntegrationLogStatus,
  PaginatedResult,
} from '@accounting/types';
import type { ListIntegrationLogsQuery } from '@accounting/validation';
import { RequestContext } from '@/common/context/request-context';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { integrationLogs, type IntegrationLog } from '@/database/schema';
import { redact } from '../core/redaction';

export interface IntegrationLogEntry {
  organizationId: string;
  integrationId?: string | null;
  direction: IntegrationDirection;
  operation: string;
  status: IntegrationLogStatus;
  requestId?: string | null;
  externalEventId?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  durationMs?: number | null;
  message?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Structured, redacted trail of every integration operation. Both the
 * database row and the pino line carry the same correlation id so a failure
 * can be followed from the UI to the logs.
 */
@Injectable()
export class IntegrationLogsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('Integration');
  }

  async record(entry: IntegrationLogEntry, executor: DbExecutor = this.db): Promise<void> {
    const ctx = RequestContext.get();
    const metadata = redact(entry.metadata ?? {});
    const row = {
      organizationId: entry.organizationId,
      integrationId: entry.integrationId ?? null,
      direction: entry.direction,
      requestId: entry.requestId ?? null,
      correlationId: ctx?.correlationId ?? null,
      externalEventId: entry.externalEventId ?? null,
      operation: entry.operation,
      status: entry.status,
      httpStatus: entry.httpStatus ?? null,
      errorCode: entry.errorCode ?? null,
      durationMs: entry.durationMs ?? null,
      message: entry.message ? entry.message.slice(0, 2000) : null,
      metadata,
    };
    try {
      await executor.insert(integrationLogs).values(row);
    } catch (err) {
      // Logging must never break the operation it describes.
      this.logger.warn({ err }, 'Failed to persist integration log');
    }
    const line = {
      integrationId: row.integrationId,
      organizationId: row.organizationId,
      direction: row.direction,
      operation: row.operation,
      status: row.status,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      httpStatus: row.httpStatus,
      correlationId: row.correlationId,
      requestId: row.requestId,
    };
    if (entry.status === 'FAILURE') this.logger.warn(line, entry.message ?? 'integration failure');
    else this.logger.info(line, entry.message ?? 'integration operation');
  }

  async list(
    organizationId: string,
    query: ListIntegrationLogsQuery,
  ): Promise<PaginatedResult<IntegrationLog>> {
    const filters: SQL[] = [eq(integrationLogs.organizationId, organizationId)];
    if (query.integrationId) filters.push(eq(integrationLogs.integrationId, query.integrationId));
    if (query.direction) filters.push(eq(integrationLogs.direction, query.direction));
    if (query.status) filters.push(eq(integrationLogs.status, query.status));
    if (query.operation) filters.push(eq(integrationLogs.operation, query.operation));
    if (query.from) filters.push(gte(integrationLogs.occurredAt, new Date(query.from)));
    if (query.to) filters.push(lte(integrationLogs.occurredAt, new Date(query.to)));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        sql`(${integrationLogs.operation} ILIKE ${term} OR ${integrationLogs.message} ILIKE ${term} OR ${integrationLogs.correlationId} ILIKE ${term} OR ${integrationLogs.externalEventId} ILIKE ${term})`,
      );
    }
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(integrationLogs)
        .where(where)
        .orderBy(desc(integrationLogs.occurredAt), desc(integrationLogs.id))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, integrationLogs, where),
    ]);
    return toPaginatedResult(items, total, query);
  }

  /** Aggregates used by health scoring. */
  async stats(
    integrationId: string,
    since: Date,
  ): Promise<{
    failures: number;
    successes: number;
    avgLatencyMs: number | null;
    p95LatencyMs: number | null;
  }> {
    const [row] = await this.db
      .select({
        failures: sql<number>`count(*) filter (where ${integrationLogs.status} = 'FAILURE')::int`,
        successes: sql<number>`count(*) filter (where ${integrationLogs.status} = 'SUCCESS')::int`,
        avgLatencyMs: sql<number | null>`avg(${integrationLogs.durationMs})::int`,
        p95LatencyMs: sql<
          number | null
        >`(percentile_cont(0.95) within group (order by ${integrationLogs.durationMs}))::int`,
      })
      .from(integrationLogs)
      .where(
        and(
          eq(integrationLogs.integrationId, integrationId),
          gte(integrationLogs.occurredAt, since),
        ),
      );
    return {
      failures: Number(row?.failures ?? 0),
      successes: Number(row?.successes ?? 0),
      avgLatencyMs:
        row?.avgLatencyMs === null || row?.avgLatencyMs === undefined
          ? null
          : Number(row.avgLatencyMs),
      p95LatencyMs:
        row?.p95LatencyMs === null || row?.p95LatencyMs === undefined
          ? null
          : Number(row.p95LatencyMs),
    };
  }
}
