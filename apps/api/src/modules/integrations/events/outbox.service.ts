import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { OutboundEventType } from '@accounting/types';
import { RequestContext } from '@/common/context/request-context';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { companies, integrationEvents, type IntegrationEvent } from '@/database/schema';

export const OUTBOX_ENQUEUED_EVENT = 'integration.outbox.enqueued';

export interface OutboxEventInput {
  eventType: OutboundEventType;
  companyId?: string | null;
  organizationId?: string;
  /** Makes the write idempotent, e.g. `journal.posted:<entryId>`. */
  dedupeKey?: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Transactional outbox. Domain services call `enqueue(tx, ...)` inside the
 * same transaction as the business change, so an event exists if and only if
 * the change committed. The dispatcher (webhooks) drains PENDING rows later;
 * nothing here talks to the network.
 *
 * Global module: it depends on the database only, so any domain module can
 * use it without importing the integrations module.
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly emitter: EventEmitter2,
  ) {}

  async enqueue(tx: DbExecutor, input: OutboxEventInput): Promise<IntegrationEvent | null> {
    let organizationId = input.organizationId ?? RequestContext.get()?.organizationId;
    if (!organizationId && input.companyId) {
      const [company] = await tx
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, input.companyId));
      organizationId = company?.organizationId;
    }
    if (!organizationId) return null;
    const [row] = await tx
      .insert(integrationEvents)
      .values({
        organizationId,
        companyId: input.companyId ?? null,
        direction: 'OUTBOUND',
        eventType: input.eventType,
        dedupeKey: input.dedupeKey ?? null,
        payload: input.payload,
        status: 'PENDING',
        correlationId: RequestContext.get()?.correlationId ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      // The caller's transaction is still open; nudge the dispatcher shortly after it commits.
      setTimeout(() => this.emitter.emit(OUTBOX_ENQUEUED_EVENT, { eventId: row.id }), 250).unref();
    }
    return row ?? null;
  }

  /** Oldest PENDING outbox rows (dispatcher input). */
  async pending(limit = 100, executor: DbExecutor = this.db): Promise<IntegrationEvent[]> {
    return executor
      .select()
      .from(integrationEvents)
      .where(
        and(eq(integrationEvents.direction, 'OUTBOUND'), eq(integrationEvents.status, 'PENDING')),
      )
      .orderBy(asc(integrationEvents.occurredAt))
      .limit(limit);
  }

  async markProcessed(id: string, executor: DbExecutor = this.db): Promise<void> {
    await executor
      .update(integrationEvents)
      .set({ status: 'PROCESSED', processedAt: new Date() })
      .where(eq(integrationEvents.id, id));
  }

  async markFailed(id: string, error: string, executor: DbExecutor = this.db): Promise<void> {
    await executor
      .update(integrationEvents)
      .set({
        status: 'FAILED',
        lastError: error.slice(0, 1000),
        attempts: sql`${integrationEvents.attempts} + 1`,
      })
      .where(eq(integrationEvents.id, id));
  }

  /** Processed rows older than `days` with no delivery still referencing them. */
  async purgeProcessed(days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await this.db
      .delete(integrationEvents)
      .where(
        and(
          eq(integrationEvents.status, 'PROCESSED'),
          lt(integrationEvents.occurredAt, cutoff),
          sql`not exists (select 1 from integration_webhook_deliveries d where d.event_id = ${integrationEvents.id})`,
        ),
      )
      .returning({ id: integrationEvents.id });
    return rows.length;
  }
}
