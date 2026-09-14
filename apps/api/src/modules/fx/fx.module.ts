import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ExchangeRatesService } from './exchange-rates.service';
import { ExchangeRatesController, FxRevaluationsController } from './fx.controller';
import { FxService } from './fx.service';

/** Exchange rates, realized FX on settlement and period-end revaluation. Subledgers import this module. */
@Module({
  imports: [AccountingModule, RbacModule],
  controllers: [ExchangeRatesController, FxRevaluationsController],
  providers: [ExchangeRatesService, FxService],
  exports: [ExchangeRatesService, FxService],
})
export class FxModule {}
