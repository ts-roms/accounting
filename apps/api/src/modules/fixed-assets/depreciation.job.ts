import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { users } from '@/database/schema';
import { SYSTEM_USER_EMAIL } from '@/database/seed/seed';
import { QUEUES, QueueService } from '@/modules/jobs/queue.service';
import { DepreciationRunsService } from './depreciation-runs.service';

const JOB_NAME = 'depreciation-monthly';

/**
 * Automated depreciation: on the 1st of every month, draft the previous
 * period's run for every company (and post it where the company opted in).
 * The system actor is recorded on the run and the journal.
 */
@Injectable()
export class DepreciationJob implements OnModuleInit {
  constructor(
    private readonly queues: QueueService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly runs: DepreciationRunsService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {
    this.logger.setContext(DepreciationJob.name);
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) return;
    try {
      this.queues.registerWorker(QUEUES.MAINTENANCE, async (job) => {
        if (job.name === JOB_NAME) await this.run();
      });
      await this.queues
        .queue(QUEUES.MAINTENANCE)
        .upsertJobScheduler(JOB_NAME, { pattern: '0 2 1 * *' }, { name: JOB_NAME });
    } catch (err) {
      this.logger.warn({ err }, 'Could not schedule the depreciation job (is Redis running?)');
    }
  }

  async run(): Promise<void> {
    const actor = await this.systemActor();
    if (!actor) {
      this.logger.warn('No system scheduler user; skipping depreciation job');
      return;
    }
    const results = await this.runs.runScheduled(new Date().toISOString().slice(0, 10), actor);
    this.logger.info({ results }, 'Depreciation job finished');
  }

  /** The seeded scheduler user owns automated postings so audit rows and journals carry a real actor. */
  private async systemActor(): Promise<AuthenticatedUser | null> {
    const [user] = await this.db.select().from(users).where(eq(users.email, SYSTEM_USER_EMAIL));
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationId: user.organizationId,
      sessionId: 'scheduler',
      permissions: new Set<string>(),
      roleKeys: [],
      system: true,
    };
  }
}
