import { Inject, Injectable } from '@nestjs/common';
import { and, inArray, lt, sql } from 'drizzle-orm';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  integrationEvents,
  integrationLogs,
  integrationSyncJobs,
  integrationWebhookDeliveries,
} from '@/database/schema';

/** How many rows one DELETE statement removes; keeps locks and WAL bursts small on large tables. */
const BATCH = 5_000;
const DAY_MS = 24 * 3600 * 1000;

export interface RetentionPolicy {
  logDays: number;
  eventDays: number;
  deliveryDays: number;
  syncJobDays: number;
  /** Dead letters (failed / exhausted rows) survive this multiple of their table's retention. */
  deadLetterMultiplier: number;
}

export interface RetentionSummary {
  logs: number;
  events: number;
  deliveries: number;
  syncJobs: number;
}

/**
 * Retention for the integration tables, driven by the env policy and run by
 * the nightly integration-cleanup job. Terminal rows go after their retention
 * window; rows that are still dead letters (FAILED events, EXHAUSTED
 * deliveries, FAILED sync jobs nobody resumed) are kept twice as long so an
 * operator has time to replay or discard them. Deletes run in bounded batches.
 * Outbox rows referenced by deliveries are purged by the outbox service once
 * their deliveries are gone, so deliveries are compacted first.
 */
@Injectable()
export class IntegrationRetentionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly config: AppConfigService,
  ) {}

  policy(): RetentionPolicy {
    const env = this.config.env;
    return {
      logDays: env.INTEGRATION_LOG_RETENTION_DAYS,
      eventDays: env.INTEGRATION_EVENT_RETENTION_DAYS,
      deliveryDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
      syncJobDays: env.SYNC_JOB_RETENTION_DAYS,
      deadLetterMultiplier: 2,
    };
  }

  async compact(now = new Date()): Promise<RetentionSummary> {
    const p = this.policy();
    const cutoff = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const deliveries =
      (await this.batched(() =>
        this.db
          .delete(integrationWebhookDeliveries)
          .where(
            inArray(
              integrationWebhookDeliveries.id,
              this.db
                .select({ id: integrationWebhookDeliveries.id })
                .from(integrationWebhookDeliveries)
                .where(
                  and(
                    inArray(integrationWebhookDeliveries.status, ['DELIVERED', 'DISABLED']),
                    lt(integrationWebhookDeliveries.createdAt, cutoff(p.deliveryDays)),
                  ),
                )
                .limit(BATCH),
            ),
          )
          .returning({ id: integrationWebhookDeliveries.id }),
      )) +
      (await this.batched(() =>
        this.db
          .delete(integrationWebhookDeliveries)
          .where(
            inArray(
              integrationWebhookDeliveries.id,
              this.db
                .select({ id: integrationWebhookDeliveries.id })
                .from(integrationWebhookDeliveries)
                .where(
                  and(
                    inArray(integrationWebhookDeliveries.status, ['EXHAUSTED', 'FAILED']),
                    lt(
                      integrationWebhookDeliveries.createdAt,
                      cutoff(p.deliveryDays * p.deadLetterMultiplier),
                    ),
                  ),
                )
                .limit(BATCH),
            ),
          )
          .returning({ id: integrationWebhookDeliveries.id }),
      ));
    // Events: processed / duplicate / rejected rows after the window, FAILED (dead letters) after twice the window;
    // an outbound event still referenced by a delivery is never removed from under it.
    const noDelivery = sql`not exists (select 1 from integration_webhook_deliveries d where d.event_id = ${integrationEvents.id})`;
    const events =
      (await this.batched(() =>
        this.db
          .delete(integrationEvents)
          .where(
            inArray(
              integrationEvents.id,
              this.db
                .select({ id: integrationEvents.id })
                .from(integrationEvents)
                .where(
                  and(
                    inArray(integrationEvents.status, ['PROCESSED', 'DUPLICATE', 'REJECTED']),
                    lt(integrationEvents.occurredAt, cutoff(p.eventDays)),
                    noDelivery,
                  ),
                )
                .limit(BATCH),
            ),
          )
          .returning({ id: integrationEvents.id }),
      )) +
      (await this.batched(() =>
        this.db
          .delete(integrationEvents)
          .where(
            inArray(
              integrationEvents.id,
              this.db
                .select({ id: integrationEvents.id })
                .from(integrationEvents)
                .where(
                  and(
                    inArray(integrationEvents.status, ['FAILED']),
                    lt(integrationEvents.occurredAt, cutoff(p.eventDays * p.deadLetterMultiplier)),
                    noDelivery,
                  ),
                )
                .limit(BATCH),
            ),
          )
          .returning({ id: integrationEvents.id }),
      ));
    const syncJobs =
      (await this.batched(() =>
        this.db
          .delete(integrationSyncJobs)
          .where(
            inArray(
              integrationSyncJobs.id,
              this.db
                .select({ id: integrationSyncJobs.id })
                .from(integrationSyncJobs)
                .where(
                  and(
                    inArray(integrationSyncJobs.status, ['COMPLETED', 'CANCELLED']),
                    lt(integrationSyncJobs.createdAt, cutoff(p.syncJobDays)),
                  ),
                )
                .limit(BATCH),
            ),
          )
          .returning({ id: integrationSyncJobs.id }),
      )) +
      (await this.batched(() =>
        this.db
          .delete(integrationSyncJobs)
          .where(
            inArray(
              integrationSyncJobs.id,
              this.db
                .select({ id: integrationSyncJobs.id })
                .from(integrationSyncJobs)
                .where(
                  and(
                    inArray(integrationSyncJobs.status, ['FAILED']),
                    lt(
                      integrationSyncJobs.createdAt,
                      cutoff(p.syncJobDays * p.deadLetterMultiplier),
                    ),
                  ),
                )
                .limit(BATCH),
            ),
          )
          .returning({ id: integrationSyncJobs.id }),
      ));
    const logs = await this.batched(() =>
      this.db
        .delete(integrationLogs)
        .where(
          inArray(
            integrationLogs.id,
            this.db
              .select({ id: integrationLogs.id })
              .from(integrationLogs)
              .where(lt(integrationLogs.occurredAt, cutoff(p.logDays)))
              .limit(BATCH),
          ),
        )
        .returning({ id: integrationLogs.id }),
    );
    return { logs, events, deliveries, syncJobs };
  }

  /** Repeats a bounded delete until it removes fewer rows than the batch size. */
  private async batched(run: () => Promise<Array<{ id: string }>>): Promise<number> {
    let total = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const rows = await run();
      total += rows.length;
      if (rows.length < BATCH) break;
    }
    return total;
  }
}
