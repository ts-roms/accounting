import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { IntegrityModule } from '@/modules/accounting/integrity/integrity.module';
import { FinancialCloseModule } from '@/modules/financial-close/financial-close.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReconciliationModule } from '@/modules/reconciliation/reconciliation.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { ControlsController } from './controls.controller';
import { ControlsService } from './controls.service';

/** Read-only control dashboard over the other modules' controls (suspense lives in AccountingModule). */
@Module({
  imports: [
    AccountingModule,
    IntegrityModule,
    FinancialCloseModule,
    RbacModule,
    ReconciliationModule,
    WorkflowsModule,
  ],
  controllers: [ControlsController],
  providers: [ControlsService],
  exports: [ControlsService],
})
export class ControlsModule {}
