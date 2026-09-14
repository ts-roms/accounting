import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { IntegrityModule } from '@/modules/accounting/integrity/integrity.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReconciliationModule } from '@/modules/reconciliation/reconciliation.module';
import { ReportingModule } from '@/modules/reporting/reporting.module';
import { FinancialCloseController } from './financial-close.controller';
import { FinancialCloseService } from './financial-close.service';

/** Month / quarter / year-end close checklists with policy-driven blockers and approval. */
@Module({
  imports: [AccountingModule, RbacModule, ReconciliationModule, IntegrityModule, ReportingModule],
  controllers: [FinancialCloseController],
  providers: [FinancialCloseService],
  exports: [FinancialCloseService],
})
export class FinancialCloseModule {}
