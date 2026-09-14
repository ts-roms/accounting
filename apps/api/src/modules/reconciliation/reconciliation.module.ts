import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { PayablesModule } from '@/modules/payables/payables.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import {
  AccountingPoliciesController,
  ReconciliationController,
} from './reconciliation.controller';
import { ReconciliationsService } from './reconciliations.service';
import { SubledgerBalancesService } from './subledger-balances.service';

/**
 * Generalised subledger-to-control reconciliation: one service derives every
 * subledger balance, one records and controls the reconciliation lifecycle.
 */
@Module({
  imports: [AccountingModule, RbacModule, ReceivablesModule, PayablesModule, InventoryModule],
  controllers: [ReconciliationController, AccountingPoliciesController],
  providers: [SubledgerBalancesService, ReconciliationsService],
  exports: [SubledgerBalancesService, ReconciliationsService],
})
export class ReconciliationModule {}
