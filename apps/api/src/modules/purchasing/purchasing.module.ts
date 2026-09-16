import { Module } from '@nestjs/common';
import { P } from '@accounting/types';
import { createPurchaseOrderSchema, createPurchaseRequestSchema } from '@accounting/validation';
import { OrdersModule } from '@/modules/orders/orders.module';
import { createOrderController } from '@/modules/orders/order-controller.factory';
import { createReturnsController } from '@/modules/orders/returns.controller';
import { GoodsReceiptsController, PurchasingSettingsController } from './purchasing.controller';

/** Purchase request -> approval -> purchase order -> goods receipt -> bill (AP, three-way matched) -> payment. */
export const PurchaseRequestsController = createOrderController({
  path: 'purchase-requests',
  tag: 'Purchase Requests',
  type: 'PURCHASE_REQUEST',
  createSchema: createPurchaseRequestSchema,
  permissions: {
    view: P['purchase-request.view'],
    create: P['purchase-request.create'],
    approve: P['purchase-request.approve'],
  },
  actions: {
    submit: P['purchase-request.create'],
    approve: P['purchase-request.approve'],
    reject: P['purchase-request.approve'],
    cancel: P['purchase-request.create'],
  },
  convert: P['purchase-order.create'],
});

export const PurchaseOrdersController = createOrderController({
  path: 'purchase-orders',
  tag: 'Purchase Orders',
  type: 'PURCHASE_ORDER',
  createSchema: createPurchaseOrderSchema,
  permissions: {
    view: P['purchase-order.view'],
    create: P['purchase-order.create'],
    approve: P['purchase-order.approve'],
  },
  actions: {
    submit: P['purchase-order.create'],
    approve: P['purchase-order.approve'],
    reject: P['purchase-order.approve'],
    close: P['purchase-order.create'],
    cancel: P['purchase-order.create'],
  },
  fulfil: {
    permission: P['bill.create'],
    summary:
      'Raise a draft vendor bill for the outstanding (or given) quantities; runs the three-way match',
  },
});

export const PurchaseReturnsController = createReturnsController({
  path: 'purchase-returns',
  tag: 'Purchase Returns',
  type: 'PURCHASE',
  permissions: {
    view: P['purchase-return.view'],
    create: P['purchase-return.create'],
    approve: P['purchase-return.approve'],
  },
});

@Module({
  imports: [OrdersModule],
  controllers: [
    PurchaseRequestsController,
    PurchaseOrdersController,
    GoodsReceiptsController,
    PurchaseReturnsController,
    PurchasingSettingsController,
  ],
})
export class PurchasingModule {}
