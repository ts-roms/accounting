import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { P } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import { organizations } from '@/database/schema';
import { IntegrityModule } from '@/modules/accounting/integrity/integrity.module';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { QueueService } from '@/modules/jobs/queue.service';
import { IntegrityScheduleService } from './integrity-schedule.service';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsService } from './metrics.service';
import {
  IntegrityRunsController,
  MetricsController,
  OperationsController,
  ReadinessController,
} from './operations.controller';
import { RuntimeStatusService } from './runtime-status.service';
import { StaleJobsService } from './stale-jobs.service';
import { StatementsService } from './statements.service';

/**
 * Operations & reliability (hardening H8): job registry views, queue dead
 * letters, scheduled integrity checks, readiness / draining, metrics. The
 * module composes existing services and stores only run outcomes.
 */
@Module({
  imports: [JobsModule, IntegrityModule],
  controllers: [
    OperationsController,
    IntegrityRunsController,
    ReadinessController,
    MetricsController,
  ],
  providers: [
    RuntimeStatusService,
    IntegrityScheduleService,
    StaleJobsService,
    StatementsService,
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [RuntimeStatusService, MetricsService],
})
export class OperationsModule implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly registry: JobRegistryService,
    private readonly notifications: NotificationsService,
    private readonly metrics: MetricsService,
    private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    // Failed job runs page the operators (throttled per job by the notification policy).
    this.registry.onFailure(async (run) => {
      const orgs = await this.db.select({ id: organizations.id }).from(organizations);
      for (const org of orgs)
        await this.notifications.notify({
          organizationId: org.id,
          eventType: 'JOB_FAILED',
          severity: 'ERROR',
          title: `Background job failed: ${run.jobName}`,
          body: run.error ?? 'Unknown error',
          link: '/admin/operations',
          entityType: 'JobRun',
          entityId: run.id,
          permission: P['operations.manage'],
          dedupeKey: `job-failed:${run.jobName}`,
        });
    });
    this.registry.onFinished((run) =>
      this.metrics.increment('job_runs_total', { job: run.jobName, status: run.status }),
    );
    this.metrics.registerGauge('queue_jobs', 'Jobs per queue and state', async () => {
      const stats = await this.queues.stats();
      if (!stats) return [];
      return stats.flatMap((q) =>
        (['waiting', 'active', 'delayed', 'failed'] as const).map((state) => ({
          labels: { queue: q.name, state },
          value: q[state],
        })),
      );
    });
  }
}
