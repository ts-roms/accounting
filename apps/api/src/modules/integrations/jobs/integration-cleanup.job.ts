import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { QUEUES } from '@/modules/jobs/queue.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { OutboxService } from '../events/outbox.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { IntegrationRetentionService } from '../ops/integration-retention.service';
import { SyncService } from '../sync/sync.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';

const JOB = 'integration-cleanup';

/**
 * Nightly housekeeping: expired idempotency keys and API keys, stale SYNCING
 * states, then the retention policy (logs, events, deliveries, sync jobs -
 * see IntegrationRetentionService) and the outbox rows those deliveries kept
 * alive. Batched and idempotent, so a missed night simply catches up.
 */
@Injectable()
export class IntegrationCleanupJob implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: JobRunnerService,
    private readonly idempotency: IdempotencyService,
    private readonly apiKeys: ApiKeysService,
    private readonly outbox: OutboxService,
    private readonly sync: SyncService,
    private readonly retention: IntegrationRetentionService,
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
    const [idempotency, apiKeys, stale] = await Promise.all([
      this.idempotency.purgeExpired(),
      this.apiKeys.expireDue(),
      this.sync.recoverStale(),
    ]);
    // Deliveries first: an outbox row is only purged once nothing references it.
    const compacted = await this.retention.compact();
    const outbox = await this.outbox.purgeProcessed(this.retention.policy().eventDays);
    const summary = { idempotency, apiKeys, stale, outbox, ...compacted };
    this.logger.info(summary, 'Integration cleanup finished');
    return summary;
  }
}
