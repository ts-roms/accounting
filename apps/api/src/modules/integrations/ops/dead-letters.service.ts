import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SyncEntity } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  integrationEvents,
  integrationSyncJobs,
  integrationWebhookDeliveries,
  integrationWebhooks,
  integrations,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '../events/outbox.service';
import { SyncService } from '../sync/sync.service';
import { InboundWebhooksService } from '../webhooks/inbound-webhooks.service';
import { OutboundWebhooksService } from '../webhooks/outbound-webhooks.service';

const MODULE = 'INTEGRATIONS';
const PER_KIND = 100;

export const DEAD_LETTER_KINDS = [
  'WEBHOOK_DELIVERY',
  'INBOUND_EVENT',
  'OUTBOX_EVENT',
  'SYNC_JOB',
] as const;
export type DeadLetterKind = (typeof DEAD_LETTER_KINDS)[number];

export interface DeadLetterView {
  kind: DeadLetterKind;
  id: string;
  /** Integration or webhook the row belongs to, for the link in the UI. */
  ownerId: string | null;
  ownerName: string;
  /** Event type, sync entity or job description. */
  subject: string;
  error: string | null;
  attempts: number;
  occurredAt: Date;
  /** Whether a replay is possible (exhausted deliveries, failed events / jobs) as opposed to discard only. */
  replayable: boolean;
}

export interface DeadLettersView {
  summary: Record<DeadLetterKind, number>;
  items: DeadLetterView[];
}

/**
 * One queue for everything the platform could not deliver, receive, dispatch
 * or run: exhausted outbound deliveries, FAILED inbound events, FAILED outbox
 * rows and FAILED sync / push jobs nobody resumed. Replay hands each kind to
 * its own idempotent path (delivery replay rows, inbound event re-processing,
 * outbox re-dispatch, sync resume from the checkpoint); discard marks the row
 * as acknowledged so it leaves the queue but stays as history for retention.
 */
@Injectable()
export class DeadLettersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly outbound: OutboundWebhooksService,
    private readonly inbound: InboundWebhooksService,
    private readonly sync: SyncService,
  ) {}

  async list(organizationId: string): Promise<DeadLettersView> {
    const [deliveries, inboundEvents, outboxEvents, syncJobs] = await Promise.all([
      this.deliveries(organizationId),
      this.events(organizationId, 'INBOUND'),
      this.events(organizationId, 'OUTBOUND'),
      this.syncJobs(organizationId),
    ]);
    const items = [
      ...deliveries.items,
      ...inboundEvents.items,
      ...outboxEvents.items,
      ...syncJobs.items,
    ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return {
      summary: {
        WEBHOOK_DELIVERY: deliveries.total,
        INBOUND_EVENT: inboundEvents.total,
        OUTBOX_EVENT: outboxEvents.total,
        SYNC_JOB: syncJobs.total,
      },
      items,
    };
  }

  async replay(
    actor: AuthenticatedUser,
    kind: DeadLetterKind,
    id: string,
  ): Promise<{ kind: DeadLetterKind; id: string; result: string }> {
    const organizationId = actor.organizationId;
    let result: string;
    switch (kind) {
      case 'WEBHOOK_DELIVERY': {
        const row = await this.delivery(organizationId, id);
        const r = await this.outbound.replay(actor, row.webhookId, { deliveryIds: [id] });
        result = `${r.replayed} delivery re-queued`;
        break;
      }
      case 'INBOUND_EVENT': {
        const event = await this.inbound.replay(organizationId, id);
        result = `event ${event.status.toLowerCase()}`;
        break;
      }
      case 'OUTBOX_EVENT': {
        await this.event(organizationId, id, 'OUTBOUND');
        const ok = await this.outbox.requeue(id);
        if (!ok)
          throw new BusinessRuleError(
            ErrorCodes.INTEGRATION_INVALID_STATE,
            'The outbox event is no longer FAILED.',
          );
        result = 'event re-queued for dispatch';
        break;
      }
      case 'SYNC_JOB': {
        const job = await this.syncJob(organizationId, id);
        const resumed = await this.sync.trigger(
          actor,
          organizationId,
          job.integrationId,
          {
            entity: (job.entity as SyncEntity | null) ?? undefined,
            mode: job.mode,
            resumeJobId: job.id,
          },
          'RESUME',
          job.direction,
        );
        result = `resumed as job ${resumed.id}`;
        break;
      }
    }
    await this.audit.record({
      action: 'UPDATE',
      module: MODULE,
      entityType: 'DeadLetter',
      entityId: id,
      newValue: { kind, action: 'REPLAY', result },
      organizationId,
      userId: actor.id,
      userEmail: actor.email,
    });
    return { kind, id, result };
  }

  /** Acknowledges a dead letter without processing it; the row stays as history until retention removes it. */
  async discard(
    actor: AuthenticatedUser,
    kind: DeadLetterKind,
    id: string,
  ): Promise<{ kind: DeadLetterKind; id: string; status: string }> {
    const organizationId = actor.organizationId;
    const note = `Discarded by ${actor.email}`;
    let status: string;
    switch (kind) {
      case 'WEBHOOK_DELIVERY': {
        await this.delivery(organizationId, id);
        await this.db
          .update(integrationWebhookDeliveries)
          .set({ status: 'DISABLED', lastError: note })
          .where(eq(integrationWebhookDeliveries.id, id));
        status = 'DISABLED';
        break;
      }
      case 'INBOUND_EVENT':
      case 'OUTBOX_EVENT': {
        const event = await this.event(
          organizationId,
          id,
          kind === 'INBOUND_EVENT' ? 'INBOUND' : 'OUTBOUND',
        );
        await this.db
          .update(integrationEvents)
          .set({
            status: 'REJECTED',
            lastError: `${note}${event.lastError ? ` - ${event.lastError}` : ''}`.slice(0, 1000),
            processedAt: new Date(),
          })
          .where(eq(integrationEvents.id, id));
        status = 'REJECTED';
        break;
      }
      case 'SYNC_JOB': {
        await this.syncJob(organizationId, id);
        await this.db
          .update(integrationSyncJobs)
          .set({ status: 'CANCELLED', errorMessage: note })
          .where(eq(integrationSyncJobs.id, id));
        status = 'CANCELLED';
        break;
      }
    }
    await this.audit.record({
      action: 'UPDATE',
      module: MODULE,
      entityType: 'DeadLetter',
      entityId: id,
      newValue: { kind, action: 'DISCARD', status },
      organizationId,
      userId: actor.id,
      userEmail: actor.email,
    });
    return { kind, id, status };
  }

  /** Replays every dead letter of a kind (or all kinds); returns per-kind counts. */
  async replayAll(
    actor: AuthenticatedUser,
    kind?: DeadLetterKind,
  ): Promise<Record<DeadLetterKind, number>> {
    const view = await this.list(actor.organizationId);
    const counts: Record<DeadLetterKind, number> = {
      WEBHOOK_DELIVERY: 0,
      INBOUND_EVENT: 0,
      OUTBOX_EVENT: 0,
      SYNC_JOB: 0,
    };
    for (const item of view.items) {
      if (kind && item.kind !== kind) continue;
      if (!item.replayable) continue;
      try {
        await this.replay(actor, item.kind, item.id);
        counts[item.kind] += 1;
      } catch {
        // A row that cannot be replayed (state moved on, sync in progress) stays in the queue.
      }
    }
    return counts;
  }

  // ----------------------------------------------------------------- queries

  private async deliveries(organizationId: string) {
    // Exhausted deliveries that no later replay row has picked up.
    const notReplayed = sql`not exists (select 1 from integration_webhook_deliveries r where r.replay_of_id = ${integrationWebhookDeliveries.id} and r.status not in ('EXHAUSTED', 'DISABLED'))`;
    const where = and(
      eq(integrationWebhooks.organizationId, organizationId),
      eq(integrationWebhookDeliveries.status, 'EXHAUSTED'),
      notReplayed,
    );
    const rows = await this.db
      .select({
        id: integrationWebhookDeliveries.id,
        webhookId: integrationWebhookDeliveries.webhookId,
        webhookName: integrationWebhooks.name,
        eventType: integrationWebhookDeliveries.eventType,
        lastError: integrationWebhookDeliveries.lastError,
        attempts: integrationWebhookDeliveries.attempts,
        createdAt: integrationWebhookDeliveries.createdAt,
      })
      .from(integrationWebhookDeliveries)
      .innerJoin(
        integrationWebhooks,
        eq(integrationWebhooks.id, integrationWebhookDeliveries.webhookId),
      )
      .where(where)
      .orderBy(desc(integrationWebhookDeliveries.createdAt))
      .limit(PER_KIND);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationWebhookDeliveries)
      .innerJoin(
        integrationWebhooks,
        eq(integrationWebhooks.id, integrationWebhookDeliveries.webhookId),
      )
      .where(where);
    return {
      total: Number(count?.n ?? 0),
      items: rows.map<DeadLetterView>((r) => ({
        kind: 'WEBHOOK_DELIVERY',
        id: r.id,
        ownerId: r.webhookId,
        ownerName: r.webhookName,
        subject: r.eventType,
        error: r.lastError,
        attempts: r.attempts,
        occurredAt: r.createdAt,
        replayable: true,
      })),
    };
  }

  private async events(organizationId: string, direction: 'INBOUND' | 'OUTBOUND') {
    const where = and(
      eq(integrationEvents.organizationId, organizationId),
      eq(integrationEvents.direction, direction),
      eq(integrationEvents.status, 'FAILED'),
    );
    const rows = await this.db
      .select({
        id: integrationEvents.id,
        integrationId: integrationEvents.integrationId,
        integrationName: integrations.name,
        eventType: integrationEvents.eventType,
        lastError: integrationEvents.lastError,
        attempts: integrationEvents.attempts,
        occurredAt: integrationEvents.occurredAt,
      })
      .from(integrationEvents)
      .leftJoin(integrations, eq(integrations.id, integrationEvents.integrationId))
      .where(where)
      .orderBy(desc(integrationEvents.occurredAt))
      .limit(PER_KIND);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationEvents)
      .where(where);
    return {
      total: Number(count?.n ?? 0),
      items: rows.map<DeadLetterView>((r) => ({
        kind: direction === 'INBOUND' ? 'INBOUND_EVENT' : 'OUTBOX_EVENT',
        id: r.id,
        ownerId: r.integrationId,
        ownerName:
          r.integrationName ?? (direction === 'INBOUND' ? 'unknown integration' : 'outbox'),
        subject: r.eventType,
        error: r.lastError,
        attempts: r.attempts,
        occurredAt: r.occurredAt,
        replayable: true,
      })),
    };
  }

  private async syncJobs(organizationId: string) {
    const notResumed = sql`not exists (select 1 from integration_sync_jobs r where r.resumed_from_job_id = ${integrationSyncJobs.id})`;
    const where = and(
      eq(integrationSyncJobs.organizationId, organizationId),
      eq(integrationSyncJobs.status, 'FAILED'),
      notResumed,
    );
    const rows = await this.db
      .select({
        id: integrationSyncJobs.id,
        integrationId: integrationSyncJobs.integrationId,
        integrationName: integrations.name,
        entity: integrationSyncJobs.entity,
        direction: integrationSyncJobs.direction,
        errorCode: integrationSyncJobs.errorCode,
        errorMessage: integrationSyncJobs.errorMessage,
        createdAt: integrationSyncJobs.createdAt,
      })
      .from(integrationSyncJobs)
      .innerJoin(integrations, eq(integrations.id, integrationSyncJobs.integrationId))
      .where(and(where, isNull(integrations.deletedAt)))
      .orderBy(desc(integrationSyncJobs.createdAt))
      .limit(PER_KIND);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationSyncJobs)
      .innerJoin(integrations, eq(integrations.id, integrationSyncJobs.integrationId))
      .where(and(where, isNull(integrations.deletedAt)));
    return {
      total: Number(count?.n ?? 0),
      items: rows.map<DeadLetterView>((r) => ({
        kind: 'SYNC_JOB',
        id: r.id,
        ownerId: r.integrationId,
        ownerName: r.integrationName,
        subject: `${r.direction === 'OUTBOUND' ? 'push' : 'sync'}:${r.entity ?? 'all'}`,
        error: r.errorCode ? `${r.errorCode}: ${r.errorMessage ?? ''}` : r.errorMessage,
        attempts: 1,
        occurredAt: r.createdAt,
        replayable: true,
      })),
    };
  }

  private async delivery(organizationId: string, id: string) {
    const [row] = await this.db
      .select({
        id: integrationWebhookDeliveries.id,
        webhookId: integrationWebhookDeliveries.webhookId,
      })
      .from(integrationWebhookDeliveries)
      .innerJoin(
        integrationWebhooks,
        eq(integrationWebhooks.id, integrationWebhookDeliveries.webhookId),
      )
      .where(
        and(
          eq(integrationWebhookDeliveries.id, id),
          eq(integrationWebhooks.organizationId, organizationId),
        ),
      );
    if (!row) throw new NotFoundError('Webhook delivery', id);
    return row;
  }

  private async event(organizationId: string, id: string, direction: 'INBOUND' | 'OUTBOUND') {
    const [row] = await this.db
      .select()
      .from(integrationEvents)
      .where(
        and(
          eq(integrationEvents.id, id),
          eq(integrationEvents.organizationId, organizationId),
          eq(integrationEvents.direction, direction),
        ),
      );
    if (!row) throw new NotFoundError('Integration event', id);
    return row;
  }

  private async syncJob(organizationId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(integrationSyncJobs)
      .where(
        and(
          eq(integrationSyncJobs.id, id),
          eq(integrationSyncJobs.organizationId, organizationId),
          inArray(integrationSyncJobs.status, ['FAILED', 'PAUSED', 'CANCELLED']),
        ),
      );
    if (!row) throw new NotFoundError('Sync job', id);
    return row;
  }
}
