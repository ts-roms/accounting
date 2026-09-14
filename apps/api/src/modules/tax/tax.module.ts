import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { TaxCodesService } from './tax-codes.service';
import { TaxEngineService } from './tax-engine.service';
import { TaxReportsService } from './tax-reports.service';
import { TaxController } from './tax.controller';

/**
 * The tax engine: codes and effective-dated rates as data, per-line computation,
 * balancing journal lines and the append-only `tax_transactions` register.
 * Subledgers and expense claims import this module; the engine never posts on its own.
 */
@Module({
  imports: [AccountingModule, RbacModule],
  controllers: [TaxController],
  providers: [TaxCodesService, TaxEngineService, TaxReportsService],
  exports: [TaxEngineService, TaxCodesService],
})
export class TaxModule {}
