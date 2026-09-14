import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { FxModule } from '@/modules/fx/fx.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ConsolidationController, IntercompanyController } from './consolidation.controller';
import { ConsolidationService } from './consolidation.service';
import { IntercompanyService } from './intercompany.service';

/** Multi-company: intercompany transactions (mirrored entries) and the consolidated trial balance. */
@Module({
  imports: [AccountingModule, FxModule, RbacModule],
  controllers: [ConsolidationController, IntercompanyController],
  providers: [ConsolidationService, IntercompanyService],
})
export class ConsolidationModule {}
