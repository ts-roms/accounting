import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { AuditAction, PaginatedResult } from '@accounting/types';
import type { FieldHistoryQuery, ListAuditLogsQuery } from '@accounting/validation';
import { RequestContext } from '@/common/context/request-context';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { auditLogs, fieldChanges, type AuditLog, type FieldChange } from '@/database/schema';

export interface AuditEntry {
  action: AuditAction;
  module: string;
  entityType: string;
  entityId?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  /** `metadata.reason` is kept with the field-level history of an update. */
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

  /**
   * Writes the audit event and, when the event carries a before and an after
   * object, one field-level history row per changed top-level field. The
   * history is derived here so every module that audits an update with
   * previous / new values gets it without extra code.
   */
  async record(entry: AuditEntry, executor: DbExecutor = this.db): Promise<void> {
    const ctx = RequestContext.get();
    const organizationId = entry.organizationId ?? ctx?.organizationId ?? null;
    const companyId = entry.companyId ?? ctx?.companyId ?? null;
    const userId = entry.userId ?? ctx?.userId ?? null;
    const userEmail = entry.userEmail ?? ctx?.userEmail ?? null;
    const correlationId = ctx?.correlationId ?? null;
    const [row] = await executor
      .insert(auditLogs)
      .values({
        organizationId,
        companyId,
        userId,
        userEmail,
        action: entry.action,
        module: entry.module,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        previousValue: entry.previousValue ?? null,
        newValue: entry.newValue ?? null,
        metadata: entry.metadata ?? null,
        ipAddress: ctx?.ipAddress ?? null,
        userAgent: ctx?.userAgent ?? null,
        correlationId,
      })
      .returning({ id: auditLogs.id });
    // Only data edits produce field history; workflow actions (submit, approve, post...)
    // also carry a before / after status but they are events, not edits.
    const changes = entry.action === 'UPDATE' ? fieldDiff(entry.previousValue, entry.newValue) : [];
    if (!row || !entry.entityId || changes.length === 0) return;
    const reason = entry.metadata?.reason;
    await executor.insert(fieldChanges).values(
      changes.map((c) => ({
        auditLogId: row.id,
        organizationId,
        companyId,
        entityType: entry.entityType,
        entityId: entry.entityId!,
        field: c.field,
        // Wrapped: a bare JSON string in a jsonb column is parsed twice by the driver stack
        // ("100000.0000" would come back as the number 100000).
        previousValue: { value: c.previous },
        newValue: { value: c.next },
        changedBy: userId,
        changedByEmail: userEmail,
        reason: typeof reason === 'string' && reason.length > 0 ? reason : null,
        correlationId,
      })),
    );
  }

  /** Field-level history of one record, oldest first. */
  async history(
    organizationId: string,
    query: FieldHistoryQuery,
    companyId?: string | null,
  ): Promise<FieldChange[]> {
    const filters: SQL[] = [
      eq(fieldChanges.organizationId, organizationId),
      eq(fieldChanges.entityType, query.entityType),
      eq(fieldChanges.entityId, query.entityId),
    ];
    if (companyId) filters.push(eq(fieldChanges.companyId, companyId));
    if (query.field) filters.push(eq(fieldChanges.field, query.field));
    const rows = await this.db
      .select()
      .from(fieldChanges)
      .where(and(...filters))
      .orderBy(asc(fieldChanges.changedAt), asc(fieldChanges.id));
    return rows.map((r) => ({
      ...r,
      previousValue: unwrap(r.previousValue),
      newValue: unwrap(r.newValue),
    }));
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

/**
 * Top-level fields whose value differs between two plain objects. Only object
 * pairs are compared - scalar or array payloads carry no field structure.
 */
export function fieldDiff(
  previous: unknown,
  next: unknown,
): Array<{ field: string; previous: unknown; next: unknown }> {
  if (!isPlainObject(previous) || !isPlainObject(next)) return [];
  const out: Array<{ field: string; previous: unknown; next: unknown }> = [];
  for (const field of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const a = previous[field];
    const b = next[field];
    if (a === undefined || b === undefined) continue; // partial payloads: only fields present on both sides
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push({ field, previous: a ?? null, next: b ?? null });
  }
  return out;
}

function unwrap(value: unknown): unknown {
  return isPlainObject(value) && 'value' in value ? value.value : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
