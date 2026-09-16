import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import {
  AdHocReportController,
  ReportDefinitionsController,
} from './engine/report-engine.controller';
import { ReportEngineService } from './engine/report-engine.service';
import { ReportingController } from './reporting.controller';
import { ReportingService } from './reporting.service';
import { TraceController } from './trace/trace.controller';
import { TraceService } from './trace/trace.service';

@Module({
  imports: [AccountingModule],
  controllers: [
    ReportingController,
    ReportDefinitionsController,
    AdHocReportController,
    TraceController,
  ],
  providers: [ReportingService, ReportEngineService, TraceService],
  exports: [ReportingService, ReportEngineService, TraceService],
})
export class ReportingModule {}
