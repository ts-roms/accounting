import { Module } from '@nestjs/common';
import { AccountingModule } from '@/modules/accounting/accounting.module';
import { WorkflowsModule } from '@/modules/workflows/workflows.module';
import { InventoryCoreModule } from '@/modules/inventory/inventory-core.module';
import { PayablesModule } from '@/modules/payables/payables.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { ReceivablesModule } from '@/modules/receivables/receivables.module';
import { GoodsReceiptsService } from './goods-receipts.service';
import { OrdersCoreModule } from './orders-core.module';
import { OrdersService } from './orders.service';
import { ReturnsService } from './returns.service';

/**
 * Order lifecycle services shared by the sales and purchasing modules. Depends
 * on the AR / AP subledgers so invoicing and billing an order happens in the
 * same transaction as the order update.
 */
@Module({
  imports: [
    AccountingModule,
    RbacModule,
    ReceivablesModule,
    PayablesModule,
    OrdersCoreModule,
    InventoryCoreModule,
    WorkflowsModule,
  ],
  providers: [OrdersService, GoodsReceiptsService, ReturnsService],
  exports: [OrdersService, GoodsReceiptsService, ReturnsService, OrdersCoreModule],
})
export class OrdersModule {}
