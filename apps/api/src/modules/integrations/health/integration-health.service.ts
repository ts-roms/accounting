import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  integrationEvents,
  integrationSyncJobs,
  integrations,
  oauthConnections,
  type Integration,
} from '@/database/schema';
import { QUEUES } from '@/modules/jobs/queue.service';
import { CredentialsService } from '../core/credentials.service';
import { IntegrationsService } from '../core/integrations.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutboundWebhooksService } from '../webhooks/outbound-webhooks.service';
import { computeHealth, type HealthReport } from './health.logic';

const JOB_CHECK = 'integration-health-check';

/** Measured throughput over the last 24 hours, next to the score: what the operator looks at when the score drops. */
export interface IntegrationMetrics {
  windowHours: number;
  calls: number;
  failures: number;
  /** failures / calls, 0..1; null when there were no calls. */
  errorRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  syncJobs: number;
  syncJobsFailed: number;
  recordsProcessed: number;
  recordsCreated: number;
  recordsUpdated: number;
  recordsFailed: number;
  webhooksDelivered: number;
  webhooksExhausted: number;
  /** FAILED inbound / outbox events and FAILED, un-resumed sync jobs waiting in the dead-letter queue. */
  deadLetters: number;
}

export interface IntegrationHealthView extends HealthReport {
  integrationId: string;
  metrics: IntegrationMetrics;
  checkedAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  failureCount: number;
  nextSyncAt: Date | null;
  lastSyncAt: Date | null;
}

/** Gathers the measured signals for one integration and scores them (pure logic in health.logic.ts). */
@Injectable()
export class IntegrationHealthService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly integrations: IntegrationsService,
    private readonly credentials: CredentialsService,
    private readonly logs: IntegrationLogsService,
    private readonly webhooks: OutboundWebhooksService,
    private readonly notifications: NotificationsService,
    private readonly jobs: JobRunnerService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IntegrationHealthService.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.INTEGRATION_MAINTENANCE, JOB_CHECK, () => this.checkAll());
    void this.jobs.schedule(
      QUEUES.INTEGRATION_MAINTENANCE,
      JOB_CHECK,
      { every: 10 * 60_000 },
      {},
      'Recompute integration health scores and raise failing-connector notifications',
    );
  }

  async evaluate(integration: Integration, persist = true): Promise<IntegrationHealthView> {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const [stats, credentialsExpireAt, webhookIds, [oauth]] = await Promise.all([
      this.logs.stats(integration.id, since),
      this.credentials.earliestExpiry(integration.id),
      this.webhooks.webhookIdsForIntegration(integration.id),
      this.db
        .select({ status: oauthConnections.status })
        .from(oauthConnections)
        .where(eq(oauthConnections.integrationId, integration.id)),
    ]);
    const wh = await this.webhooks.healthFor(webhookIds);
    const [syncStats, deadLetters] = await Promise.all([
      this.syncStats(integration.id, since),
      this.deadLetterCount(integration.id),
    ]);
    const connector = this.integrations.connector(integration.provider);
    const report = computeHealth({
      status: integration.status,
      now,
      lastSuccessAt: integration.lastSuccessAt,
      lastFailureAt: integration.lastFailureAt,
      failureCount: integration.failureCount,
      credentialsExpireAt,
      oauthStatus: oauth?.status ?? null,
      failures24h: stats.failures,
      successes24h: stats.successes,
      avgLatencyMs: stats.avgLatencyMs,
      webhookExhausted24h: wh.exhausted24h,
      webhookDelivered24h: wh.delivered24h,
      providerRateLimited: this.integrations.throttle.state(
        integration.provider,
        connector.descriptor.rateLimitPerSecond,
      ).limited,
      syncOverdue: Boolean(
        integration.syncSchedule &&
        integration.nextSyncAt &&
        integration.nextSyncAt.getTime() < now.getTime() - 15 * 60_000,
      ),
    });
    if (persist)
      await this.db
        .update(integrations)
        .set({ healthStatus: report.status, healthScore: report.score, healthCheckedAt: now })
        .where(eq(integrations.id, integration.id));
    if (
      report.credentialExpiry.state === 'EXPIRING' ||
      report.credentialExpiry.state === 'EXPIRED'
    ) {
      await this.notifications.notify({
        organizationId: integration.organizationId,
        eventType: 'CREDENTIALS_EXPIRING',
        severity: report.credentialExpiry.state === 'EXPIRED' ? 'ERROR' : 'WARNING',
        title: `Credentials for "${integration.name}" ${report.credentialExpiry.state === 'EXPIRED' ? 'have expired' : `expire in ${report.credentialExpiry.daysLeft} day(s)`}`,
        link: `/admin/integrations/${integration.id}`,
        entityType: 'Integration',
        entityId: integration.id,
        permission: 'integration.manage',
        companyId: integration.companyId,
        dedupeKey: `credentials-expiring:${integration.id}`,
      });
    }
    const calls = stats.failures + stats.successes;
    return {
      ...report,
      integrationId: integration.id,
      metrics: {
        windowHours: 24,
        calls,
        failures: stats.failures,
        errorRate: calls ? Number((stats.failures / calls).toFixed(4)) : null,
        avgLatencyMs: stats.avgLatencyMs,
        p95LatencyMs: stats.p95LatencyMs,
        ...syncStats,
        webhooksDelivered: wh.delivered24h,
        webhooksExhausted: wh.exhausted24h,
        deadLetters,
      },
      checkedAt: now,
      lastSuccessAt: integration.lastSuccessAt,
      lastFailureAt: integration.lastFailureAt,
      lastError: integration.lastError,
      failureCount: integration.failureCount,
      nextSyncAt: integration.nextSyncAt,
      lastSyncAt: integration.lastSyncAt,
    };
  }

  async checkAll(): Promise<number> {
    const rows = await this.db
      .select()
      .from(integrations)
      .where(and(isNull(integrations.deletedAt)));
    for (const row of rows) {
      try {
        await this.evaluate(row);
      } catch (err) {
        this.logger.warn({ err, integrationId: row.id }, 'Health check failed');
      }
    }
    return rows.length;
  }

  private async syncStats(integrationId: string, since: Date) {
    const [row] = await this.db
      .select({
        syncJobs: sql<number>`count(*)::int`,
        syncJobsFailed: sql<number>`count(*) filter (where ${integrationSyncJobs.status} = 'FAILED')::int`,
        recordsProcessed: sql<number>`coalesce(sum(${integrationSyncJobs.recordsProcessed}), 0)::int`,
        recordsCreated: sql<number>`coalesce(sum(${integrationSyncJobs.recordsCreated}), 0)::int`,
        recordsUpdated: sql<number>`coalesce(sum(${integrationSyncJobs.recordsUpdated}), 0)::int`,
        recordsFailed: sql<number>`coalesce(sum(${integrationSyncJobs.recordsFailed}), 0)::int`,
      })
      .from(integrationSyncJobs)
      .where(
        and(
          eq(integrationSyncJobs.integrationId, integrationId),
          gte(integrationSyncJobs.createdAt, since),
        ),
      );
    return {
      syncJobs: Number(row?.syncJobs ?? 0),
      syncJobsFailed: Number(row?.syncJobsFailed ?? 0),
      recordsProcessed: Number(row?.recordsProcessed ?? 0),
      recordsCreated: Number(row?.recordsCreated ?? 0),
      recordsUpdated: Number(row?.recordsUpdated ?? 0),
      recordsFailed: Number(row?.recordsFailed ?? 0),
    };
  }

  private async deadLetterCount(integrationId: string): Promise<number> {
    const [events] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationEvents)
      .where(
        and(
          eq(integrationEvents.integrationId, integrationId),
          eq(integrationEvents.status, 'FAILED'),
        ),
      );
    const [jobs] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationSyncJobs)
      .where(
        and(
          eq(integrationSyncJobs.integrationId, integrationId),
          eq(integrationSyncJobs.status, 'FAILED'),
          sql`not exists (select 1 from integration_sync_jobs r where r.resumed_from_job_id = ${integrationSyncJobs.id})`,
        ),
      );
    return Number(events?.n ?? 0) + Number(jobs?.n ?? 0);
  }
}
