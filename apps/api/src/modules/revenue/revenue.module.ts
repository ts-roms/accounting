import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { RevenueConfigService } from './revenue-config.service';
import { RevenueReportsService } from './revenue-reports.service';
import { RevenueRunsService } from './revenue-runs.service';
import { RevenueSchedulesService } from './revenue-schedules.service';
import { RevenueController } from './revenue.controller';
import { RevenueRecognitionJob } from './revenue.job';

/**
 * Revenue recognition & deferred revenue (Prompt #10). Imported by the
 * receivables module (invoice posting creates the schedules), so it must
 * never import receivables itself.
 */
@Module({
  imports: [AccountingModule, JobsModule, RbacModule],
  controllers: [RevenueController],
  providers: [
    RevenueConfigService,
    RevenueSchedulesService,
    RevenueRunsService,
    RevenueReportsService,
    RevenueRecognitionJob,
  ],
  exports: [
    RevenueConfigService,
    RevenueSchedulesService,
    RevenueRunsService,
    RevenueReportsService,
  ],
})
export class RevenueModule {}
