import { Module } from '@nestjs/common';
import { FxModule } from '@/modules/fx/fx.module';
import { TaxModule } from '@/modules/tax/tax.module';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { InventoryCoreModule } from '@/modules/inventory/inventory-core.module';
import { OrdersCoreModule } from '@/modules/orders/orders-core.module';
import { ArReportsService } from './ar-reports.service';
import { CustomerPaymentsService } from './customer-payments.service';
import { CustomersService } from './customers.service';
import { InvoicesService } from './invoices.service';
import {
  ArReportsController,
  CustomerPaymentsController,
  CustomersController,
  InvoicesController,
} from './receivables.controller';

/** Accounts receivable: customers, invoices/credit/debit notes, receipts, allocations, aging, statements. */
@Module({
  imports: [
    AccountingModule,
    OrdersCoreModule,
    InventoryCoreModule,
    TaxModule,
    FxModule,
    RbacModule,
  ],
  controllers: [
    CustomersController,
    InvoicesController,
    CustomerPaymentsController,
    ArReportsController,
  ],
  providers: [CustomersService, InvoicesService, CustomerPaymentsService, ArReportsService],
  exports: [CustomersService, InvoicesService, CustomerPaymentsService, ArReportsService],
})
export class ReceivablesModule {}
