import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { BankingModule } from '@/modules/banking/banking.module';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { FxModule } from '@/modules/fx/fx.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { BankTransfersService } from './bank-transfers.service';
import { CashForecastService } from './cash-forecast.service';
import { CashPositionService } from './cash-position.service';
import { PaymentFilesService } from './payment-files.service';
import { PettyCashService } from './petty-cash.service';
import { TreasuryConfigService } from './treasury-config.service';
import { TreasuryDashboardService } from './treasury-dashboard.service';
import { TreasuryIntegrityService } from './treasury-integrity.service';
import {
  BankTransfersController,
  PaymentFilesController,
  PettyCashController,
  TreasuryController,
} from './treasury.controller';
import { TreasurySweepJob } from './treasury.job';

/**
 * Cash management and treasury (Prompt #8): cash position, rolling cash
 * forecast, inter-account transfers through cash in transit, bank payment
 * files, imprest petty cash and the daily treasury sweep.
 */
@Module({
  imports: [
    AccountingModule,
    BankingModule,
    FxModule,
    WorkflowsModule,
    DelegationsModule,
    RbacModule,
    JobsModule,
    ReceivablesModule,
  ],
  controllers: [
    TreasuryController,
    BankTransfersController,
    PaymentFilesController,
    PettyCashController,
  ],
  providers: [
    TreasuryConfigService,
    CashPositionService,
    CashForecastService,
    BankTransfersService,
    PaymentFilesService,
    PettyCashService,
    TreasuryDashboardService,
    TreasuryIntegrityService,
    TreasurySweepJob,
  ],
  exports: [
    TreasuryConfigService,
    CashPositionService,
    CashForecastService,
    BankTransfersService,
    PaymentFilesService,
    PettyCashService,
    TreasuryDashboardService,
    TreasuryIntegrityService,
  ],
})
export class TreasuryModule {}
