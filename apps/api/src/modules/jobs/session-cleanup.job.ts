import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { lt } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { sessions } from '@/database/schema';
import { QUEUES, QueueService } from './queue.service';

const JOB_NAME = 'session-cleanup';

/**
 * Nightly removal of expired refresh sessions. Serves as the reference
 * implementation for repeatable BullMQ jobs in this codebase.
 */
@Injectable()
export class SessionCleanupJob implements OnModuleInit {
  constructor(
    private readonly queues: QueueService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {
    this.logger.setContext(SessionCleanupJob.name);
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      this.queues.registerWorker(QUEUES.MAINTENANCE, async (job) => {
        if (job.name === JOB_NAME) await this.run();
      });
      await this.queues
        .queue(QUEUES.MAINTENANCE)
        .upsertJobScheduler(JOB_NAME, { pattern: '0 3 * * *' }, { name: JOB_NAME });
    } catch (err) {
      // Redis being unavailable must not prevent the API from serving requests.
      this.logger.warn({ err }, 'Could not schedule maintenance jobs (is Redis running?)');
    }
  }

  async run(): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
    const deleted = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, cutoff))
      .returning({ id: sessions.id });
    this.logger.info({ deleted: deleted.length }, 'Expired sessions purged');
    return deleted.length;
  }
}
