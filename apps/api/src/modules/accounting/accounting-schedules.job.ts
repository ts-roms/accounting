import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { PrepaymentsService } from './prepayments/prepayments.service';
import { RecurringJournalsService } from './recurring/recurring-journals.service';

const JOB_NAME = 'accounting-schedules';

/**
 * Nightly run of the accounting schedules for every company: due recurring
 * journal occurrences (drafts, or posted for templates a `journal.post`
 * holder switched to AUTO_POST) and due prepayment recognitions. Both
 * services are idempotent per occurrence, so a rerun never double-posts.
 */
@Injectable()
export class AccountingSchedulesJob implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistryService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly recurring: RecurringJournalsService,
    private readonly prepayments: PrepaymentsService,
  ) {
    this.logger.setContext(AccountingSchedulesJob.name);
  }

  async onModuleInit(): Promise<void> {
    const pattern = this.config.env.ACCOUNTING_SCHEDULES_CRON;
    await this.registry.scheduleRepeatable({
      name: JOB_NAME,
      description:
        'Generate due recurring journal occurrences and recognise due prepayment instalments for every company',
      queue: QUEUES.ACCOUNTING_SCHEDULES,
      repeat: pattern ? { pattern } : null,
      run: () => this.run(),
    });
  }

  async run(asOf?: string): Promise<Record<string, number>> {
    const recurring = await this.recurring.runAllCompanies(asOf);
    const prepayments = await this.prepayments.recognizeAllCompanies(asOf);
    const summary = {
      recurringGenerated: Object.values(recurring).reduce((n, r) => n + r.generated.length, 0),
      recurringSkipped: Object.values(recurring).reduce((n, r) => n + r.skipped.length, 0),
      recognized: Object.values(prepayments).reduce((n, r) => n + r.recognized.length, 0),
    };
    this.logger.info(summary, 'Accounting schedules finished');
    return summary;
  }
}
