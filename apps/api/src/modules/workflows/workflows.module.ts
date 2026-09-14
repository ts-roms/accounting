import { Module } from '@nestjs/common';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController, WorkflowsController } from './workflows.controller';

/**
 * Configurable approval chains. Document modules import this and call
 * `ApprovalsService.assertApproved` at their approve / post step; the module
 * itself never touches documents or the ledger.
 */
@Module({
  imports: [RbacModule, DelegationsModule],
  controllers: [WorkflowsController, ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class WorkflowsModule {}
