import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { AuditAction, PaginatedResult } from '@accounting/types';
import type { ListAuditLogsQuery } from '@accounting/validation';
import { RequestContext } from '@/common/context/request-context';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { auditLogs, type AuditLog } from '@/database/schema';

export interface AuditEntry {
  action: AuditAction;
  module: string;
  entityType: string;
  entityId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  /** Overrides for background jobs where no request context exists. */
  organizationId?: string | null;
  companyId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
}

/**
 * Writes the immutable audit trail. Callers inside a transaction pass the
 * transaction so the audit row commits (or rolls back) with the business change.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditService.name);
  }

  async record(entry: AuditEntry, executor: DbExecutor = this.db): Promise<void> {
    const ctx = RequestContext.get();
    await executor.insert(auditLogs).values({
      organizationId: entry.organizationId ?? ctx?.organizationId ?? null,
      companyId: entry.companyId ?? ctx?.companyId ?? null,
      userId: entry.userId ?? ctx?.userId ?? null,
      userEmail: entry.userEmail ?? ctx?.userEmail ?? null,
      action: entry.action,
      module: entry.module,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      previousValue: entry.previousValue ?? null,
      newValue: entry.newValue ?? null,
      metadata: entry.metadata ?? null,
      ipAddress: ctx?.ipAddress ?? null,
      userAgent: ctx?.userAgent ?? null,
      correlationId: ctx?.correlationId ?? null,
    });
  }

  async list(
    organizationId: string,
    query: ListAuditLogsQuery,
  ): Promise<PaginatedResult<AuditLog>> {
    const filters: SQL[] = [eq(auditLogs.organizationId, organizationId)];
    if (query.action) filters.push(eq(auditLogs.action, query.action));
    if (query.module) filters.push(eq(auditLogs.module, query.module));
    if (query.entityType) filters.push(eq(auditLogs.entityType, query.entityType));
    if (query.entityId) filters.push(eq(auditLogs.entityId, query.entityId));
    if (query.userId) filters.push(eq(auditLogs.userId, query.userId));
    if (query.companyId) filters.push(eq(auditLogs.companyId, query.companyId));
    if (query.from) filters.push(gte(auditLogs.occurredAt, new Date(query.from)));
    if (query.to) filters.push(lte(auditLogs.occurredAt, new Date(query.to)));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        sql`(${auditLogs.userEmail} ILIKE ${term} OR ${auditLogs.entityType} ILIKE ${term} OR ${auditLogs.entityId} ILIKE ${term} OR ${auditLogs.correlationId} ILIKE ${term})`,
      );
    }
    const where = and(...filters);

    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, auditLogs, where),
    ]);

    return toPaginatedResult(items, total, query);
  }
}
