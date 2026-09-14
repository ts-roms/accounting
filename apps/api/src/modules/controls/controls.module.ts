import { Module } from '@nestjs/common';
import { IntegrityModule } from '@/modules/accounting/integrity/integrity.module';
import { FinancialCloseModule } from '@/modules/financial-close/financial-close.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReconciliationModule } from '@/modules/reconciliation/reconciliation.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { ControlsController } from './controls.controller';
import { ControlsService } from './controls.service';

/** Read-only control dashboard and suspense monitor over the other modules' controls. */
@Module({
  imports: [
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
