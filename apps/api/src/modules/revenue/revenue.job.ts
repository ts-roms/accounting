import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { RevenueRunsService } from './revenue-runs.service';

const JOB_NAME = 'revenue-recognition';

/**
 * Scheduled revenue recognition (Prompt #10): for every company whose
 * revenue settings opt in, post one run for the lines due up to today.
 * Runs lock the lines they recognize, so a rerun never double-posts.
 */
@Injectable()
export class RevenueRecognitionJob implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistryService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly runs: RevenueRunsService,
  ) {
    this.logger.setContext(RevenueRecognitionJob.name);
  }

  async onModuleInit(): Promise<void> {
    const pattern = this.config.env.ACCOUNTING_SCHEDULES_CRON;
    await this.registry.scheduleRepeatable({
      name: JOB_NAME,
      description: 'Post due deferred revenue for every company with automatic recognition enabled',
      queue: QUEUES.ACCOUNTING_SCHEDULES,
      repeat: pattern ? { pattern } : null,
      run: () => this.run(),
    });
  }

  async run(asOf = new Date().toISOString().slice(0, 10)): Promise<Record<string, number>> {
    const results = await this.runs.recognizeAllCompanies(asOf);
    const summary = {
      companies: results.length,
      runs: results.filter((r) => r.runId).length,
      lines: results.reduce((n, r) => n + r.lines, 0),
    };
    this.logger.info(summary, 'Revenue recognition finished');
    return summary;
  }
}
