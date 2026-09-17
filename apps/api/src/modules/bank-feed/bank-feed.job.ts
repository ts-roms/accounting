import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { BankFeedService } from './bank-feed.service';

const JOB_NAME = 'bank-feed-suggestions';

/**
 * Daily bank feed sweep (Prompt #12): refreshes suggestions for every
 * unexplained statement line and tells reviewers what waits. It never
 * posts - auto-apply needs a person's session (import, rematch, refresh).
 */
@Injectable()
export class BankFeedSweepJob implements OnModuleInit {
  constructor(
    private readonly jobs: JobRunnerService,
    private readonly logger: PinoLogger,
    private readonly feed: BankFeedService,
  ) {
    this.logger.setContext(BankFeedSweepJob.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.MAINTENANCE, JOB_NAME, () => this.run());
    void this.jobs.schedule(
      QUEUES.MAINTENANCE,
      JOB_NAME,
      { every: 24 * 60 * 60_000 },
      {},
      'Refresh bank feed suggestions and notify reviewers of unexplained lines',
    );
  }

  async run(asOf = new Date().toISOString().slice(0, 10)): Promise<Record<string, number>> {
    const summary = await this.feed.sweepAll(asOf);
    this.logger.info(summary, 'Bank feed sweep finished');
    return summary;
  }
}
