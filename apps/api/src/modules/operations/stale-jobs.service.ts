import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { integrationSyncJobs, jobRuns } from '@/database/schema';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QUEUES } from '@/modules/jobs/queue.service';

export const STALE_JOBS_JOB = 'stale-jobs-sweep';

/** How long a queued sync or a RUNNING job run may sit before it is presumed lost. */
const STALE_QUEUED_MINUTES = 30;
const STALE_RUNNING_HOURS = 6;

/**
 * Self-healing sweep (hardening H8). Work that was queued but never picked up
 * (the worker died, or the Redis keys belonged to another deployment) and job
 * runs left RUNNING by a crashed instance would otherwise block their
 * successors forever: sync jobs dedupe on an active QUEUED row and the
 * operations console would show a job "running" for days. The sweep marks
 * both FAILED with an explicit reason so the next schedule proceeds.
 */
@Injectable()
export class StaleJobsService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly registry: JobRegistryService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StaleJobsService.name);
  }

  async onModuleInit(): Promise<void> {
    await this.registry.scheduleRepeatable({
      name: STALE_JOBS_JOB,
      description:
        'Fail integration syncs queued for over 30 minutes without a worker and job runs left RUNNING by a dead instance',
      queue: QUEUES.MAINTENANCE,
      repeat: { every: 15 * 60_000 },
      run: () => this.sweep(),
    });
  }

  async sweep(now = new Date()): Promise<{ staleSyncJobs: number; staleJobRuns: number }> {
    const queuedBefore = new Date(now.getTime() - STALE_QUEUED_MINUTES * 60_000);
    const stale = await this.db
      .update(integrationSyncJobs)
      .set({
        status: 'FAILED',
        finishedAt: now,
        errorCode: 'STALE',
        errorMessage: `Queued for more than ${STALE_QUEUED_MINUTES} minutes without being picked up (worker missing or queue prefix mismatch)`,
      })
      .where(
        and(
          eq(integrationSyncJobs.status, 'QUEUED'),
          isNull(integrationSyncJobs.startedAt),
          lt(integrationSyncJobs.createdAt, queuedBefore),
        ),
      )
      .returning({ id: integrationSyncJobs.id });

    const runningBefore = new Date(now.getTime() - STALE_RUNNING_HOURS * 3_600_000);
    const runs = await this.db
      .update(jobRuns)
      .set({
        status: 'FAILED',
        finishedAt: now,
        error: `Still RUNNING after ${STALE_RUNNING_HOURS} hours; the owning instance probably died`,
      })
      .where(
        and(
          eq(jobRuns.status, 'RUNNING'),
          lt(jobRuns.startedAt, runningBefore),
          sql`${jobRuns.instanceId} <> ${this.registry.instanceId}`,
        ),
      )
      .returning({ id: jobRuns.id });

    if (stale.length || runs.length)
      this.logger.warn(
        { staleSyncJobs: stale.length, staleJobRuns: runs.length },
        'Stale jobs marked FAILED',
      );
    return { staleSyncJobs: stale.length, staleJobRuns: runs.length };
  }
}
