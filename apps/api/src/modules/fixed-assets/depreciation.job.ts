import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { DRIZZLE, type Database } from '@/database/database.types';
import { users } from '@/database/schema';
import { SYSTEM_USER_EMAIL } from '@/database/seed/seed';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QUEUES } from '@/modules/jobs/queue.service';
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
    private readonly registry: JobRegistryService,
    private readonly logger: PinoLogger,
    private readonly runs: DepreciationRunsService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {
    this.logger.setContext(DepreciationJob.name);
  }

  async onModuleInit(): Promise<void> {
    await this.registry.scheduleRepeatable({
      name: JOB_NAME,
      description:
        "Draft (and post where opted in) every company's depreciation run for the previous period",
      queue: QUEUES.MAINTENANCE,
      repeat: { pattern: '0 2 1 * *' },
      run: () => this.run(),
    });
  }

  async run(): Promise<unknown> {
    const actor = await this.systemActor();
    if (!actor) {
      this.logger.warn('No system scheduler user; skipping depreciation job');
      return { skipped: 'no system scheduler user' };
    }
    const results = await this.runs.runScheduled(new Date().toISOString().slice(0, 10), actor);
    this.logger.info({ results }, 'Depreciation job finished');
    return results;
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
