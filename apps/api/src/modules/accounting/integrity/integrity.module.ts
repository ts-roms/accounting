import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { PayablesModule } from '@/modules/payables/payables.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import { ReconciliationModule } from '@/modules/reconciliation/reconciliation.module';
import { ReportingModule } from '@/modules/reporting/reporting.module';
import { IntegrityController } from './integrity.controller';
import { IntegrityService } from './integrity.service';

/** Read-only financial integrity checks over the ledger and every subledger. */
@Module({
  imports: [
    AccountingModule,
    RbacModule,
    ReceivablesModule,
    PayablesModule,
    InventoryModule,
    ReconciliationModule,
    ReportingModule,
  ],
  controllers: [IntegrityController],
  providers: [IntegrityService],
  exports: [IntegrityService],
})
export class IntegrityModule {}
