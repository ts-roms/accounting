import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { DelegationsService } from './delegations.service';

const JOB_NAME = 'delegation-expiration';

/**
 * Every 5 minutes: mark delegations past their end EXPIRED and send expiry
 * warnings. Expiry is *also* enforced at use time by the window check, so
 * this job only keeps statuses and notifications tidy - a late tick can never
 * extend authority.
 */
@Injectable()
export class DelegationExpiryJob implements OnModuleInit {
  constructor(
    private readonly jobs: JobRunnerService,
    private readonly delegations: DelegationsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DelegationExpiryJob.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.INTEGRATION_MAINTENANCE, JOB_NAME, () => this.run());
    void this.jobs.schedule(QUEUES.INTEGRATION_MAINTENANCE, JOB_NAME, { every: 5 * 60_000 });
  }

  async run(): Promise<{ expired: number; warned: number }> {
    const result = await this.delegations.expireDue();
    if (result.expired || result.warned) this.logger.info(result, 'Delegation expiry sweep');
    return result;
  }
}
