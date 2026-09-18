import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { FxModule } from '@/modules/fx/fx.module';
import { BankingModule } from '@/modules/banking/banking.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { LeaseReportsService } from './lease-reports.service';
import { LeaseRunsService } from './lease-runs.service';
import { LeasesConfigService } from './leases-config.service';
import { LeasesController } from './leases.controller';
import { LeaseRunsJob } from './leases.job';
import { LeasesService } from './leases.service';

/**
 * Lease accounting (Prompt #13): contracts, the derived schedule, lease runs
 * (interest + depreciation), instalment payments, remeasurement and
 * termination, register / maturity reports, integrity and the scheduled run.
 */
@Module({
  imports: [AccountingModule, BankingModule, FxModule, RbacModule, JobsModule],
  controllers: [LeasesController],
  providers: [
    LeasesConfigService,
    LeasesService,
    LeaseRunsService,
    LeaseReportsService,
    LeaseRunsJob,
  ],
  exports: [LeasesConfigService, LeasesService, LeaseRunsService, LeaseReportsService],
})
export class LeasesModule {}
