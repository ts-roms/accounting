import { Module } from '@nestjs/common';
import { JobRunnerService } from './job-runner.service';
import { QueueService } from './queue.service';
import { SessionCleanupJob } from './session-cleanup.job';

/**
 * BullMQ wiring. Long-running or scheduled work (emails, report generation,
 * depreciation runs...) is queued here instead of blocking HTTP requests.
 */
@Module({
  providers: [QueueService, JobRunnerService, SessionCleanupJob],
  exports: [QueueService, JobRunnerService],
})
export class JobsModule {}
