import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { SyncEntity } from '@accounting/types';
import { AppError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';
import { integrations, type IntegrationEvent } from '@/database/schema';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { ConnectorRegistry } from '../core/connector-registry';
import {
  PUSH_DEBOUNCE_MS,
  PUSH_MAX_WAIT_ATTEMPTS,
  entitiesForEvent,
  pushRetryDelayMs,
  pushTriggerJobId,
} from './push-trigger.logic';
import { SyncService } from './sync.service';

const JOB_PUSH_ON_EVENT = 'push-on-event';

interface PushOnEventJob {
  integrationId: string;
  organizationId: string;
  entity: SyncEntity;
  /** How many times the push was postponed because another job was running. */
  attempt: number;
}

/**
 * Event-driven pushes: when the outbox dispatcher sees a domain event, every
 * CONNECTED, PUSH-capable integration of that company whose entities cover
 * the change (and whose `config.pushOnEvents` is not false) gets a delayed
 * `push-on-event` job. The job id is fixed per integration + entity, so a
 * burst of events collapses into one incremental push a few seconds later
 * (BullMQ ignores a second add with the same id while the first is waiting;
 * inline mode simply runs it). If a sync / push is already running the job
 * re-queues itself with backoff so the change made meanwhile is still sent.
 * The push itself is an ordinary OUTBOUND job (trigger EVENT) with the same
 * exporters, mapping, references, audit and retries.
 */
@Injectable()
export class PushTriggerService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: JobRunnerService,
    private readonly registry: ConnectorRegistry,
    private readonly sync: SyncService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PushTriggerService.name);
  }

  onModuleInit(): void {
    this.jobs.register<PushOnEventJob>(
      QUEUES.INTEGRATION_SYNC,
      JOB_PUSH_ON_EVENT,
      (job) => this.run(job),
      2,
    );
  }

  /** Called by the outbox dispatcher for every event; returns the number of pushes scheduled. */
  async onEvent(event: IntegrationEvent): Promise<number> {
    const entities = entitiesForEvent(
      event.eventType,
      (event.payload ?? {}) as Record<string, unknown>,
    );
    if (!entities.length || !event.companyId) return 0;
    const candidates = await this.db
      .select({
        id: integrations.id,
        organizationId: integrations.organizationId,
        provider: integrations.provider,
        config: integrations.config,
      })
      .from(integrations)
      .where(
        and(
          isNull(integrations.deletedAt),
          inArray(integrations.status, ['CONNECTED', 'SYNCING']),
          eq(integrations.companyId, event.companyId),
        ),
      );
    let scheduled = 0;
    for (const candidate of candidates) {
      if (!this.registry.has(candidate.provider)) continue;
      const connector = this.registry.get(candidate.provider);
      if (!connector.descriptor.capabilities.includes('PUSH') || !connector.push) continue;
      const config = (candidate.config ?? {}) as Record<string, unknown>;
      if (config.pushOnEvents === false) continue;
      for (const entity of entities) {
        if (!connector.descriptor.entities.includes(entity)) continue;
        await this.schedule(
          {
            integrationId: candidate.id,
            organizationId: candidate.organizationId,
            entity,
            attempt: 0,
          },
          PUSH_DEBOUNCE_MS,
        );
        scheduled += 1;
      }
    }
    return scheduled;
  }

  private async schedule(job: PushOnEventJob, delay: number): Promise<void> {
    // Retries need their own ids: the queue ignores an add that reuses the id of the job currently running.
    const base = pushTriggerJobId(job.integrationId, job.entity);
    await this.jobs.enqueue(QUEUES.INTEGRATION_SYNC, JOB_PUSH_ON_EVENT, job, {
      jobId: job.attempt ? `${base}:retry:${job.attempt}` : base,
      delay,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  private async run(job: PushOnEventJob): Promise<void> {
    try {
      await this.sync.trigger(
        null,
        job.organizationId,
        job.integrationId,
        { entity: job.entity, mode: 'INCREMENTAL' },
        'EVENT',
        'OUTBOUND',
      );
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCodes.SYNC_IN_PROGRESS) {
        // Another job holds the integration; come back after it, the change is still unsent.
        if (job.attempt + 1 >= PUSH_MAX_WAIT_ATTEMPTS) {
          this.logger.warn(
            { integrationId: job.integrationId, entity: job.entity },
            'Event-driven push gave up waiting for a running job',
          );
          return;
        }
        const attempt = job.attempt + 1;
        await this.schedule({ ...job, attempt }, pushRetryDelayMs(attempt));
        return;
      }
      // Disabled / disconnected meanwhile, or an unsupported entity: nothing to push.
      this.logger.info(
        { err, integrationId: job.integrationId, entity: job.entity },
        'Event-driven push not started',
      );
    }
  }
}
