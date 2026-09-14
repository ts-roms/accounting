import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { SessionCleanupJob } from './session-cleanup.job';

/**
 * BullMQ wiring. Long-running or scheduled work (emails, report generation,
 * depreciation runs...) is queued here instead of blocking HTTP requests.
 */
@Module({
  providers: [QueueService, SessionCleanupJob],
  exports: [QueueService],
})
export class JobsModule {}
