import { Module } from '@nestjs/common';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { FxModule } from '@/modules/fx/fx.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { TaxModule } from '@/modules/tax/tax.module';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { InventoryCoreModule } from '@/modules/inventory/inventory-core.module';
import { OrdersCoreModule } from '@/modules/orders/orders-core.module';
import { ApReportsService } from './ap-reports.service';
import { VendorPaymentsService } from './vendor-payments.service';
import { VendorsService } from './vendors.service';
import { BillsService } from './bills.service';
import {
  ApReportsController,
  VendorPaymentsController,
  VendorsController,
  BillsController,
} from './payables.controller';

/** Accounts receivable: vendors, bills/credit/debit notes, receipts, allocations, aging, statements. */
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
  ],
  controllers: [VendorsController, BillsController, VendorPaymentsController, ApReportsController],
  providers: [VendorsService, BillsService, VendorPaymentsService, ApReportsService],
  exports: [VendorsService, BillsService, VendorPaymentsService, ApReportsService],
})
export class PayablesModule {}
