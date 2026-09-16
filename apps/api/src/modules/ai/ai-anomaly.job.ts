import { Injectable, type OnModuleInit, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { AppConfigService } from '@/config/app-config.service';
import { DRIZZLE, type Database } from '@/database/database.types';
import { companies } from '@/database/schema';
import { JobRegistryService } from '@/modules/jobs/job-registry.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { AiAnomalyService } from './ai-anomaly.service';

const JOB_NAME = 'ai-anomaly-scan';

/**
 * Nightly anomaly scan over the last `AI_ANOMALY_SCAN_DAYS` days for every
 * active company. Flags are upserted by fingerprint, so the job only ever adds
 * new things to look at; nothing is posted or changed.
 */
@Injectable()
export class AiAnomalyJob implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistryService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
    private readonly anomalies: AiAnomalyService,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {
    this.logger.setContext(AiAnomalyJob.name);
  }

  async onModuleInit(): Promise<void> {
    await this.registry.scheduleRepeatable({
      name: JOB_NAME,
      description: 'Advisory anomaly scan of recent postings for every active company',
      queue: QUEUES.MAINTENANCE,
      repeat: this.config.env.AI_ANOMALY_SCAN_DAYS === 0 ? null : { pattern: '30 3 * * *' },
      run: () => this.run(),
    });
  }

  async run(): Promise<void> {
    const days = this.config.env.AI_ANOMALY_SCAN_DAYS;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const rows = await this.db
      .select({ id: companies.id, code: companies.code })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    for (const company of rows) {
      try {
        const result = await this.anomalies.scan(company.id, null, {
          from: from.toISOString().slice(0, 10),
          to: to.toISOString().slice(0, 10),
        });
        this.logger.info(
          { company: company.code, flagged: result.flagged, new: result.new },
          'Anomaly scan finished',
        );
      } catch (err) {
        this.logger.warn({ err, company: company.code }, 'Anomaly scan failed');
      }
    }
  }
}
