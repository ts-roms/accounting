import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { FxModule } from '@/modules/fx/fx.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import {
  ConsolidationGroupsController,
  ConsolidationPlatformController,
  ConsolidationRunsController,
  IntercompanySettlementController,
} from './consolidation-groups.controller';
import { ConsolidationGroupsService } from './consolidation-groups.service';
import { ConsolidationIntegrityService } from './consolidation-integrity.service';
import { ConsolidationRunsService } from './consolidation-runs.service';
import { ConsolidationController, IntercompanyController } from './consolidation.controller';
import { ConsolidationService } from './consolidation.service';
import { IntercompanyReconciliationService } from './intercompany-reconciliation.service';
import { IntercompanyService } from './intercompany.service';

/**
 * Multi-company (Phase 8 + Prompt #9): intercompany charges and settlements
 * (mirrored entries), the quick consolidated trial balance, and the group
 * consolidation platform - groups, elimination rules, runs with translation
 * / eliminations / NCI, consolidated statements, intercompany reconciliation
 * and integrity checks.
 */
@Module({
  imports: [AccountingModule, FxModule, RbacModule, WorkflowsModule, DelegationsModule],
  controllers: [
    ConsolidationController,
    IntercompanyController,
    IntercompanySettlementController,
    ConsolidationGroupsController,
    ConsolidationRunsController,
    ConsolidationPlatformController,
  ],
  providers: [
    ConsolidationService,
    IntercompanyService,
    ConsolidationGroupsService,
    ConsolidationRunsService,
    IntercompanyReconciliationService,
    ConsolidationIntegrityService,
  ],
  exports: [
    ConsolidationGroupsService,
    ConsolidationRunsService,
    IntercompanyReconciliationService,
    ConsolidationIntegrityService,
  ],
})
export class ConsolidationModule {}
