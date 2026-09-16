import { Module } from '@nestjs/common';
import { P } from '@accounting/types';
import { createSalesDocumentSchema } from '@accounting/validation';
import { OrdersModule } from '@/modules/orders/orders.module';
import { createOrderController } from '@/modules/orders/order-controller.factory';
import { createReturnsController } from '@/modules/orders/returns.controller';

/** Quotation -> sales order -> invoice (AR) -> receipt; sales returns -> credit note. */
export const QuotationsController = createOrderController({
  path: 'quotations',
  tag: 'Quotations',
  type: 'QUOTATION',
  createSchema: createSalesDocumentSchema,
  permissions: { view: P['quotation.view'], create: P['quotation.create'] },
  actions: {
    send: P['quotation.create'],
    accept: P['quotation.create'],
    reject: P['quotation.create'],
    cancel: P['quotation.create'],
  },
  convert: P['sales-order.create'],
});

export const SalesOrdersController = createOrderController({
  path: 'sales-orders',
  tag: 'Sales Orders',
  type: 'SALES_ORDER',
  createSchema: createSalesDocumentSchema,
  permissions: {
    view: P['sales-order.view'],
    create: P['sales-order.create'],
    approve: P['sales-order.approve'],
  },
  actions: {
    submit: P['sales-order.create'],
    approve: P['sales-order.approve'],
    reject: P['sales-order.approve'],
    confirm: P['sales-order.create'],
    close: P['sales-order.create'],
    cancel: P['sales-order.create'],
  },
  fulfil: {
    permission: P['invoice.create'],
    summary: 'Raise a draft customer invoice for the outstanding (or given) quantities',
  },
});

export const SalesReturnsController = createReturnsController({
  path: 'sales-returns',
  tag: 'Sales Returns',
  type: 'SALES',
  permissions: {
    view: P['sales-return.view'],
    create: P['sales-return.create'],
    approve: P['sales-return.approve'],
  },
});

@Module({
  imports: [OrdersModule],
  controllers: [QuotationsController, SalesOrdersController, SalesReturnsController],
})
export class SalesModule {}
