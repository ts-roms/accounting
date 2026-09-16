import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { companies } from '@/database/schema';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { CollectionsService } from './collections.service';

const JOB_NAME = 'receivables-collections-sweep';

/**
 * Daily receivables sweep: overdue detection (events + notifications),
 * automatic collection cases, dunning steps, promise evaluation and case
 * closure - per active company. Each step is idempotent so a re-run never
 * duplicates reminders or holds; nothing here posts to the ledger.
 */
@Injectable()
export class ReceivablesSweepJob implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: JobRunnerService,
    private readonly collections: CollectionsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReceivablesSweepJob.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.MAINTENANCE, JOB_NAME, () => this.run());
    void this.jobs.schedule(
      QUEUES.MAINTENANCE,
      JOB_NAME,
      { every: 24 * 60 * 60_000 },
      {},
      'Daily collections sweep: overdue detection, collection cases, dunning steps and promise evaluation',
    );
  }

  async run(): Promise<{ companies: number }> {
    const rows = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    for (const c of rows) {
      try {
        await this.collections.runSweep(c.id);
      } catch (err) {
        this.logger.error({ err, companyId: c.id }, 'Collections sweep failed');
      }
    }
    return { companies: rows.length };
  }
}
