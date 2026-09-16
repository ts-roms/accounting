import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { lt } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { sessions } from '@/database/schema';
import { JobRegistryService } from './job-registry.service';
import { QUEUES } from './queue.service';

const JOB_NAME = 'session-cleanup';

/**
 * Nightly removal of expired refresh sessions. Serves as the reference
 * implementation for repeatable BullMQ jobs in this codebase.
 */
@Injectable()
export class SessionCleanupJob implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistryService,
    private readonly logger: PinoLogger,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {
    this.logger.setContext(SessionCleanupJob.name);
  }

  async onModuleInit(): Promise<void> {
    await this.registry.scheduleRepeatable({
      name: JOB_NAME,
      description: 'Purge refresh sessions expired more than a day ago',
      queue: QUEUES.MAINTENANCE,
      repeat: { pattern: '0 3 * * *' },
      run: async () => ({ deleted: await this.run() }),
    });
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
