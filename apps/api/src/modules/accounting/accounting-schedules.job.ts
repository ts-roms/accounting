import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import { QUEUES, QueueService } from '@/modules/jobs/queue.service';
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
    private readonly queues: QueueService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly recurring: RecurringJournalsService,
    private readonly prepayments: PrepaymentsService,
  ) {
    this.logger.setContext(AccountingSchedulesJob.name);
  }

  async onModuleInit(): Promise<void> {
    const pattern = this.config.env.ACCOUNTING_SCHEDULES_CRON;
    if (this.config.isTest || !pattern) return;
    try {
      this.queues.registerWorker(QUEUES.ACCOUNTING_SCHEDULES, async (job) => {
        if (job.name === JOB_NAME) await this.run();
      });
      await this.queues
        .queue(QUEUES.ACCOUNTING_SCHEDULES)
        .upsertJobScheduler(JOB_NAME, { pattern }, { name: JOB_NAME });
    } catch (err) {
      this.logger.warn(
        { err },
        'Could not schedule the accounting schedules job (is Redis running?)',
      );
    }
  }

  async run(asOf?: string): Promise<void> {
    const recurring = await this.recurring.runAllCompanies(asOf);
    const prepayments = await this.prepayments.recognizeAllCompanies(asOf);
    this.logger.info(
      {
        recurringGenerated: Object.values(recurring).reduce((n, r) => n + r.generated.length, 0),
        recurringSkipped: Object.values(recurring).reduce((n, r) => n + r.skipped.length, 0),
        recognized: Object.values(prepayments).reduce((n, r) => n + r.recognized.length, 0),
      },
      'Accounting schedules finished',
    );
  }
}
