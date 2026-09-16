import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { BankingModule } from '@/modules/banking/banking.module';
import { FixedAssetsModule } from '@/modules/fixed-assets/fixed-assets.module';
import { InventoryModule } from '@/modules/inventory/inventory.module';
import { PayablesModule } from '@/modules/payables/payables.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import { ReconciliationModule } from '@/modules/reconciliation/reconciliation.module';
import { ReportingModule } from '@/modules/reporting/reporting.module';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { ImportMetadataController, ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { OpeningBalancesController } from './opening-balances.controller';
import { OpeningBalancesService } from './opening-balances.service';

/**
 * Data infrastructure (hardening phase 6): CSV import engine, CSV exports and
 * the controlled opening-balance process. Everything goes through the owning
 * domain services - nothing here writes ledger rows.
 */
@Module({
  imports: [
    AccountingModule,
    RbacModule,
    ReceivablesModule,
    PayablesModule,
    InventoryModule,
    BankingModule,
    FixedAssetsModule,
    ReconciliationModule,
    ReportingModule,
  ],
  controllers: [
    ImportMetadataController,
    ImportsController,
    ExportsController,
    OpeningBalancesController,
  ],
  providers: [ImportsService, ExportsService, OpeningBalancesService],
  exports: [ImportsService, ExportsService, OpeningBalancesService],
})
export class DataInfrastructureModule {}
