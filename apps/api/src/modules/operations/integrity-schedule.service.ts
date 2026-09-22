import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { P, type PaginatedResult } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { NotFoundError } from '@/common/errors/app-error';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { companies, integrityRuns, type IntegrityRun } from '@/database/schema';
import { IntegrityService } from '@/modules/accounting/integrity/integrity.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { businessToday } from '@/common/time/clock';

export const INTEGRITY_JOB = 'integrity-check';

/**
 * Scheduled financial integrity checks (hardening H8): the same read-only
 * `IntegrityService.run` the Integrity page uses, executed nightly for every
 * active company, persisted as `integrity_runs` and escalated to holders of
 * `integrity.check` when a company is not OK. Stored rows summarise; the
 * live report stays the source for drill-down.
 */
@Injectable()
export class IntegrityScheduleService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly integrity: IntegrityService,
    private readonly notifications: NotificationsService,
    private readonly registry: JobRegistryService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IntegrityScheduleService.name);
  }

  async onModuleInit(): Promise<void> {
    const pattern = this.config.env.INTEGRITY_CHECK_CRON;
    await this.registry.scheduleRepeatable({
      name: INTEGRITY_JOB,
      description:
        'Run the financial integrity checks for every active company and notify on WARNING / CRITICAL',
      queue: QUEUES.MAINTENANCE,
      repeat: pattern ? { pattern } : null,
      run: async (ctx) => this.runAll(ctx.runId, ctx.actor),
    });
  }

  /** Runs every active company; one failure never stops the others. */
  async runAll(
    jobRunId: string | null,
    actor: AuthenticatedUser | null,
  ): Promise<Record<string, string>> {
    const rows = await this.db
      .select({ id: companies.id, code: companies.code })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    const outcome: Record<string, string> = {};
    for (const company of rows) {
      const run = await this.runCompany(company.id, actor, jobRunId);
      outcome[company.code] = run.status;
    }
    return outcome;
  }

  /** Runs one company as of today, stores the outcome and notifies when it is not OK. */
  async runCompany(
    companyId: string,
    actor: AuthenticatedUser | null,
    jobRunId: string | null = null,
  ): Promise<IntegrityRun & { companyCode: string }> {
    const [company] = await this.db
      .select({ code: companies.code })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) throw new NotFoundError('Company', companyId);
    const asOf = businessToday();
    let values: typeof integrityRuns.$inferInsert;
    try {
      const report = await this.integrity.run(companyId, asOf);
      const findings = report.findings
        .filter((f) => f.count > 0)
        .map((f) => ({ name: f.check, severity: f.severity, count: f.count }));
      values = {
        companyId,
        asOf,
        status: report.status,
        criticalCount: findings.filter((f) => f.severity === 'CRITICAL').length,
        warningCount: findings.filter((f) => f.severity === 'WARNING').length,
        findings,
        jobRunId,
        triggeredBy: actor?.id ?? null,
      };
    } catch (err) {
      this.logger.error({ err, companyId }, 'Integrity check crashed');
      values = {
        companyId,
        asOf,
        status: 'FAILED',
        findings: [],
        error: (err instanceof Error ? err.message : String(err)).slice(0, 4000),
        jobRunId,
        triggeredBy: actor?.id ?? null,
      };
    }
    const [row] = await this.db.insert(integrityRuns).values(values).returning();
    const run = row!;
    if (run.status !== 'OK') await this.notify(run);
    return { ...run, companyCode: company.code };
  }

  private async notify(run: IntegrityRun): Promise<void> {
    const [company] = await this.db
      .select({ organizationId: companies.organizationId, code: companies.code })
      .from(companies)
      .where(eq(companies.id, run.companyId));
    if (!company) return;
    const worst = run.findings
      .slice()
      .sort((a, b) => (a.severity === 'CRITICAL' ? -1 : b.severity === 'CRITICAL' ? 1 : 0))
      .slice(0, 3)
      .map((f) => `${f.name} (${f.count})`)
      .join(', ');
    const delivered = await this.notifications.notify({
      organizationId: company.organizationId,
      companyId: run.companyId,
      eventType: 'INTEGRITY_ALERT',
      severity: run.status === 'WARNING' ? 'WARNING' : 'ERROR',
      title: `Integrity check ${run.status} for ${company.code}`,
      body:
        run.status === 'FAILED'
          ? `The integrity check could not complete: ${run.error ?? 'unknown error'}`
          : `${run.criticalCount} critical and ${run.warningCount} warning findings as of ${run.asOf}: ${worst}`,
      link: '/accounting/integrity',
      entityType: 'IntegrityRun',
      entityId: run.id,
      permission: P['integrity.check'],
      dedupeKey: `integrity:${run.companyId}:${run.status}`,
    });
    if (delivered > 0)
      await this.db
        .update(integrityRuns)
        .set({ notified: true })
        .where(eq(integrityRuns.id, run.id));
  }

  /** The most recent stored run of one company (what the dashboard health card shows). */
  async latest(companyId: string): Promise<(IntegrityRun & { companyCode: string }) | null> {
    const [row] = await this.db
      .select({ run: integrityRuns, companyCode: companies.code })
      .from(integrityRuns)
      .innerJoin(companies, eq(companies.id, integrityRuns.companyId))
      .where(eq(integrityRuns.companyId, companyId))
      .orderBy(desc(integrityRuns.ranAt))
      .limit(1);
    return row ? { ...row.run, companyCode: row.companyCode } : null;
  }

  async list(query: {
    companyId?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResult<IntegrityRun & { companyCode: string }>> {
    const filters: SQL[] = [];
    if (query.companyId) filters.push(eq(integrityRuns.companyId, query.companyId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, total] = await Promise.all([
      this.db
        .select({ run: integrityRuns, companyCode: companies.code })
        .from(integrityRuns)
        .innerJoin(companies, eq(companies.id, integrityRuns.companyId))
        .where(where)
        .orderBy(desc(integrityRuns.ranAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, integrityRuns, where),
    ]);
    return toPaginatedResult(
      rows.map((r) => ({ ...r.run, companyCode: r.companyCode })),
      total,
      query,
    );
  }
}
