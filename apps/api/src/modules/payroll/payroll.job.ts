import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { companies, payRuns } from '@/database/schema';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { PayrollConfigService } from './payroll-config.service';

const JOB_NAME = 'payroll-reminders';

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Daily payroll reminders (Prompt #11): runs whose pay date is within the
 * company's reminder window (or already past) and that are not yet paid
 * raise a deduped notification to the people who can post and pay them.
 * Nothing here posts.
 */
@Injectable()
export class PayrollRemindersJob implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: JobRunnerService,
    private readonly logger: PinoLogger,
    private readonly config: PayrollConfigService,
    private readonly notifications: NotificationsService,
  ) {
    this.logger.setContext(PayrollRemindersJob.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.MAINTENANCE, JOB_NAME, () => this.run());
    void this.jobs.schedule(
      QUEUES.MAINTENANCE,
      JOB_NAME,
      { every: 24 * 60 * 60_000 },
      {},
      'Remind payroll users of pay runs approaching or past their pay date',
    );
  }

  async run(
    asOf = new Date().toISOString().slice(0, 10),
  ): Promise<{ companies: number; reminders: number }> {
    const rows = await this.db
      .select({ id: companies.id, organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    let reminders = 0;
    for (const c of rows) {
      try {
        reminders += await this.remind(c.id, c.organizationId, asOf);
      } catch (err) {
        this.logger.error({ err, companyId: c.id }, 'Payroll reminders failed');
      }
    }
    return { companies: rows.length, reminders };
  }

  async remind(companyId: string, organizationId: string, asOf: string): Promise<number> {
    const settings = await this.config.settings(companyId);
    const horizon = addDays(asOf, settings.payDateReminderDays);
    const due = await this.db
      .select()
      .from(payRuns)
      .where(
        and(
          eq(payRuns.companyId, companyId),
          inArray(payRuns.status, ['CALCULATED', 'APPROVED', 'POSTED']),
          lte(payRuns.payDate, horizon),
        ),
      );
    let sent = 0;
    for (const r of due) {
      const overdue = r.payDate < asOf;
      sent += await this.notifications.notify({
        organizationId,
        eventType: 'PAY_RUN_DUE',
        severity: overdue ? 'WARNING' : 'INFO',
        title: overdue
          ? `Pay run ${r.documentNumber} is past its pay date (${r.payDate})`
          : `Pay run ${r.documentNumber} pays on ${r.payDate}`,
        body: `${r.employeeCount} employee(s), net ${r.currency} ${r.netTotal}; status ${r.status.toLowerCase()}.`,
        link: `/payroll/runs/${r.id}`,
        entityType: 'PayRun',
        entityId: r.id,
        permission: 'payroll.post',
        companyId,
        dedupeKey: `pay-run-due:${r.id}:${asOf}`,
      });
    }
    return sent;
  }
}
