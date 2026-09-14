'use client';
import { SALES_ORDER_CONFIG } from '@/lib/orders/config';
import { OrdersPage } from '@/components/orders/orders';

export default function SalesOrdersPage() {
  return <OrdersPage cfg={SALES_ORDER_CONFIG} />;
}
