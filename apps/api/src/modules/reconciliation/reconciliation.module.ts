import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { BankingModule } from '@/modules/banking/banking.module';
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
import { SuspenseService } from './suspense.service';

/**
 * Generalised subledger-to-control reconciliation: one service derives every
 * subledger balance, one records and controls the reconciliation lifecycle.
 */
@Module({
  imports: [
    AccountingModule,
    RbacModule,
    ReceivablesModule,
    PayablesModule,
    InventoryModule,
    BankingModule,
  ],
  controllers: [ReconciliationController, AccountingPoliciesController],
  providers: [SubledgerBalancesService, ReconciliationsService, SuspenseService],
  exports: [SubledgerBalancesService, ReconciliationsService, SuspenseService],
})
export class ReconciliationModule {}
