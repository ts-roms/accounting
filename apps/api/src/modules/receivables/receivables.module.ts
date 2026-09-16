import { Module } from '@nestjs/common';
import { DelegationsModule } from '@/modules/delegations/delegations.module';
import { FxModule } from '@/modules/fx/fx.module';
import { TaxModule } from '@/modules/tax/tax.module';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { InventoryCoreModule } from '@/modules/inventory/inventory-core.module';
import { OrdersCoreModule } from '@/modules/orders/orders-core.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { ArConfigService } from './ar-config.service';
import { ArDashboardService } from './ar-dashboard.service';
import { ArIntegrityService } from './ar-integrity.service';
import { ArReportsService } from './ar-reports.service';
import { CollectionsService } from './collections.service';
import { CreditService } from './credit.service';
import { CustomerPaymentsService } from './customer-payments.service';
import { CustomersService } from './customers.service';
import { DeliveriesService } from './deliveries.service';
import { DisputesService } from './disputes.service';
import { InvoicesService } from './invoices.service';
import { ReceivablesSweepJob } from './receivables.job';
import { RefundsService } from './refunds.service';
import { WriteOffsService } from './write-offs.service';
import {
  ArReportsController,
  CustomerPaymentsController,
  CustomersController,
  InvoicesController,
} from './receivables.controller';
import {
  ArPlatformReportsController,
  ArSettingsController,
  CollectionsController,
  CreditNotesController,
  CreditRulesController,
  CustomerGroupsController,
  CustomerMasterController,
  DebitNotesController,
  DeliveriesController,
  DisputesController,
  DunningPoliciesController,
  PaymentTermsController,
  PromisesController,
  ProvisionsController,
  RefundsController,
  WriteOffsController,
} from './receivables-platform.controller';

/**
 * Accounts receivable / order-to-cash platform: customer master, credit,
 * deliveries, invoices / credit / debit notes, receipts, allocations, refunds,
 * collections, disputes, write-offs, aging, statements, dashboard and the
 * AR/GL reconciliation. Every ledger effect goes through the posting gateway.
 */
@Module({
  imports: [
    AccountingModule,
    OrdersCoreModule,
    InventoryCoreModule,
    TaxModule,
    FxModule,
    DelegationsModule,
    RbacModule,
    WorkflowsModule,
    JobsModule,
  ],
  controllers: [
    CustomersController,
    CustomerMasterController,
    InvoicesController,
    CreditNotesController,
    DebitNotesController,
    CustomerPaymentsController,
    RefundsController,
    DeliveriesController,
    ArSettingsController,
    PaymentTermsController,
    CustomerGroupsController,
    CreditRulesController,
    DunningPoliciesController,
    CollectionsController,
    PromisesController,
    DisputesController,
    WriteOffsController,
    ProvisionsController,
    ArReportsController,
    ArPlatformReportsController,
  ],
  providers: [
    ArConfigService,
    CustomersService,
    CreditService,
    InvoicesService,
    CustomerPaymentsService,
    RefundsService,
    DeliveriesService,
    CollectionsService,
    DisputesService,
    WriteOffsService,
    ArReportsService,
    ArDashboardService,
    ArIntegrityService,
    ReceivablesSweepJob,
  ],
  exports: [
    ArConfigService,
    CustomersService,
    CreditService,
    InvoicesService,
    CustomerPaymentsService,
    RefundsService,
    DeliveriesService,
    CollectionsService,
    DisputesService,
    WriteOffsService,
    ArReportsService,
    ArDashboardService,
    ArIntegrityService,
  ],
})
export class ReceivablesModule {}
