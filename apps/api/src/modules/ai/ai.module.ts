import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { AttachmentsModule } from '@/modules/attachments/attachments.module';
import { BudgetingModule } from '@/modules/budgeting/budgeting.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { PayablesModule } from '@/modules/payables/payables.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import { ReportingModule } from '@/modules/reporting/reporting.module';
import { AiAnomalyJob } from './ai-anomaly.job';
import { AiAnomalyService } from './ai-anomaly.service';
import { AiAssistantService } from './ai-assistant.service';
import { AiClassifierService } from './ai-classifier.service';
import { AiIntakeService } from './ai-intake.service';
import { AiProviderService } from './ai-provider.service';
import { AiController } from './ai.controller';

/**
 * Phase 9 - AI assistance, advisory only: document intake and extraction,
 * account classification, anomaly flags, a Q&A assistant over posted data and
 * a simple forecaster. It reuses the real services for every write, so
 * permissions, approvals and posting rules are never bypassed.
 */
@Module({
  imports: [
    AccountingModule,
    RbacModule,
    AttachmentsModule,
    PayablesModule,
    ReceivablesModule,
    BudgetingModule,
    ReportingModule,
    JobsModule,
  ],
  controllers: [AiController],
  providers: [
    AiProviderService,
    AiClassifierService,
    AiIntakeService,
    AiAnomalyService,
    AiAssistantService,
    AiAnomalyJob,
  ],
  exports: [AiClassifierService, AiAnomalyService],
})
export class AiModule {}
