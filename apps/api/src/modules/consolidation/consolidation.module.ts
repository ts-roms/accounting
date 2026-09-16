import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { FxModule } from '@/modules/fx/fx.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ConsolidationGroupsController } from './consolidation-groups.controller';
import { ConsolidationGroupsService } from './consolidation-groups.service';
import { ConsolidationController, IntercompanyController } from './consolidation.controller';
import { ConsolidationService } from './consolidation.service';
import { GroupConsolidationService } from './group-consolidation.service';
import { IntercompanyService } from './intercompany.service';

/** Multi-company: intercompany transactions (mirrored entries), the consolidated trial balance and (H9) consolidation groups with translation, eliminations, adjustments and finalised runs. */
@Module({
  imports: [AccountingModule, FxModule, RbacModule],
  controllers: [ConsolidationController, IntercompanyController, ConsolidationGroupsController],
  providers: [
    ConsolidationService,
    IntercompanyService,
    ConsolidationGroupsService,
    GroupConsolidationService,
  ],
})
export class ConsolidationModule {}
