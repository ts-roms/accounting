import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { companies } from '@/database/schema';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { LeaseRunsService } from './lease-runs.service';
import { LeasesService } from './leases.service';

const JOB_NAME = 'lease-runs';

/**
 * Scheduled lease accounting (Prompt #13): for every company, post the lease
 * run for the months ended by today when the settings allow it (otherwise
 * remind), and remind the people who can pay about instalments now due.
 * Runs lock the months they post, so a rerun never double-posts.
 */
@Injectable()
export class LeaseRunsJob implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly registry: JobRegistryService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly runs: LeaseRunsService,
    private readonly leases: LeasesService,
    private readonly notifications: NotificationsService,
  ) {
    this.logger.setContext(LeaseRunsJob.name);
  }

  async onModuleInit(): Promise<void> {
    const pattern = this.config.env.ACCOUNTING_SCHEDULES_CRON;
    await this.registry.scheduleRepeatable({
      name: JOB_NAME,
      description:
        'Post due lease interest / depreciation for companies with automatic runs enabled and remind about instalments due',
      queue: QUEUES.ACCOUNTING_SCHEDULES,
      repeat: pattern ? { pattern } : null,
      run: () => this.run(),
    });
  }

  async run(asOf = new Date().toISOString().slice(0, 10)): Promise<Record<string, number>> {
    const results = await this.runs.runAllCompanies(asOf);
    const reminders = await this.remindPayments(asOf);
    const summary = {
      companies: results.length,
      runs: results.filter((r) => r.runId).length,
      lines: results.reduce((n, r) => n + r.lines, 0),
      paymentReminders: reminders,
    };
    this.logger.info(summary, 'Lease runs finished');
    return summary;
  }

  private async remindPayments(asOf: string): Promise<number> {
    const rows = await this.db
      .select({ id: companies.id, organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    let sent = 0;
    for (const c of rows) {
      try {
        const due = await this.leases.duePayments(c.id, asOf);
        for (const { lease, line } of due) {
          sent += await this.notifications.notify({
            organizationId: c.organizationId,
            eventType: 'LEASE_PAYMENT_DUE',
            severity: (line.paymentDate ?? asOf) < asOf ? 'WARNING' : 'INFO',
            title: `Lease payment due: ${lease.leaseNumber} ${lease.name}`,
            body: `${lease.currency} ${line.payment} for month ${line.sequence} was due ${line.paymentDate}.`,
            link: `/leases/${lease.id}`,
            entityType: 'Lease',
            entityId: lease.id,
            permission: 'lease.post',
            companyId: c.id,
            dedupeKey: `lease-payment-due:${line.id}`,
          });
        }
      } catch (err) {
        this.logger.error({ err, companyId: c.id }, 'Lease payment reminders failed');
      }
    }
    return sent;
  }
}
