import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { integrations, oauthConnections, type Integration } from '@/database/schema';
import { QUEUES } from '@/modules/jobs/queue.service';
import { CredentialsService } from '../core/credentials.service';
import { IntegrationsService } from '../core/integrations.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { IntegrationLogsService } from '../logs/integration-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OutboundWebhooksService } from '../webhooks/outbound-webhooks.service';
import { computeHealth, type HealthReport } from './health.logic';

const JOB_CHECK = 'integration-health-check';

export interface IntegrationHealthView extends HealthReport {
  integrationId: string;
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
    void this.jobs.schedule(QUEUES.INTEGRATION_MAINTENANCE, JOB_CHECK, { every: 10 * 60_000 });
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
    return {
      ...report,
      integrationId: integration.id,
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
}
