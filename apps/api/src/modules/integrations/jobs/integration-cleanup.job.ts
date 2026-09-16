import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { integrationLogs, integrationSyncJobs } from '@/database/schema';
import { QUEUES } from '@/modules/jobs/queue.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { OutboxService } from '../events/outbox.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { SyncService } from '../sync/sync.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';

const JOB = 'integration-cleanup';
const LOG_RETENTION_DAYS = 90;
const SYNC_JOB_RETENTION_DAYS = 180;

/** Nightly housekeeping: expired idempotency keys and API keys, old logs, processed outbox rows, stale states. */
@Injectable()
export class IntegrationCleanupJob implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: JobRunnerService,
    private readonly idempotency: IdempotencyService,
    private readonly apiKeys: ApiKeysService,
    private readonly outbox: OutboxService,
    private readonly sync: SyncService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IntegrationCleanupJob.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.INTEGRATION_MAINTENANCE, JOB, () => this.run());
    void this.jobs.schedule(
      QUEUES.INTEGRATION_MAINTENANCE,
      JOB,
      { pattern: '30 3 * * *' },
      {},
      'Purge old integration logs, delivered webhooks and expired idempotency keys',
    );
  }

  async run(): Promise<Record<string, number>> {
    const logCutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000);
    const jobCutoff = new Date(Date.now() - SYNC_JOB_RETENTION_DAYS * 24 * 3600 * 1000);
    const [idempotency, apiKeys, outbox, stale, logs, syncJobs] = await Promise.all([
      this.idempotency.purgeExpired(),
      this.apiKeys.expireDue(),
      this.outbox.purgeProcessed(30),
      this.sync.recoverStale(),
      this.db
        .delete(integrationLogs)
        .where(lt(integrationLogs.occurredAt, logCutoff))
        .returning({ id: integrationLogs.id }),
      this.db
        .delete(integrationSyncJobs)
        .where(
          and(
            lt(integrationSyncJobs.createdAt, jobCutoff),
            eq(integrationSyncJobs.status, 'COMPLETED'),
          ),
        )
        .returning({ id: integrationSyncJobs.id }),
    ]);
    const summary = {
      idempotency,
      apiKeys,
      outbox,
      stale,
      logs: logs.length,
      syncJobs: syncJobs.length,
    };
    this.logger.info(summary, 'Integration cleanup finished');
    return summary;
  }
}
