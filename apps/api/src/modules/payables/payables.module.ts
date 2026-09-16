import { Module } from '@nestjs/common';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { FxModule } from '@/modules/fx/fx.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { TaxModule } from '@/modules/tax/tax.module';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { InventoryCoreModule } from '@/modules/inventory/inventory-core.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { OrdersCoreModule } from '@/modules/orders/orders-core.module';
import { ApAccrualsService } from './ap-accruals.service';
import { ApConfigService } from './ap-config.service';
import { ApDashboardService } from './ap-dashboard.service';
import { ApIntegrityService } from './ap-integrity.service';
import { ApReportsService } from './ap-reports.service';
import { BillHoldsService } from './bill-holds.service';
import { BillsService } from './bills.service';
import { PayablesSweepJob } from './payables.job';
import { PaymentRunsService } from './payment-runs.service';
import { VendorPaymentsService } from './vendor-payments.service';
import { VendorsService } from './vendors.service';
import {
  ApReportsController,
  VendorPaymentsController,
  VendorsController,
  BillsController,
} from './payables.controller';
import {
  ApAccrualsController,
  ApReportsPlatformController,
  ApSettingsController,
  BillHoldActionsController,
  BillHoldsController,
  PaymentRunsController,
  VendorCreditsController,
  VendorDebitNotesController,
  VendorGroupsController,
  VendorMasterController,
} from './payables-platform.controller';

/**
 * Accounts payable and procure-to-pay (Prompt #7): vendor master, bills /
 * vendor credits, payment holds, vendor payments, payment runs, accruals,
 * AP reporting and the daily payables sweep.
 */
@Module({
  imports: [
    AccountingModule,
    OrdersCoreModule,
    InventoryCoreModule,
    TaxModule,
    FxModule,
    WorkflowsModule,
    DelegationsModule,
    RbacModule,
    JobsModule,
  ],
  controllers: [
    VendorsController,
    VendorMasterController,
    VendorGroupsController,
    ApSettingsController,
    BillsController,
    BillHoldActionsController,
    BillHoldsController,
    VendorCreditsController,
    VendorDebitNotesController,
    VendorPaymentsController,
    PaymentRunsController,
    ApAccrualsController,
    ApReportsController,
    ApReportsPlatformController,
  ],
  providers: [
    ApConfigService,
    VendorsService,
    BillsService,
    BillHoldsService,
    VendorPaymentsService,
    PaymentRunsService,
    ApAccrualsService,
    ApReportsService,
    ApDashboardService,
    ApIntegrityService,
    PayablesSweepJob,
  ],
  exports: [
    ApConfigService,
    VendorsService,
    BillsService,
    BillHoldsService,
    VendorPaymentsService,
    PaymentRunsService,
    ApAccrualsService,
    ApReportsService,
    ApDashboardService,
    ApIntegrityService,
  ],
})
export class PayablesModule {}
