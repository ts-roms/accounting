'use client';
import { PURCHASE_ORDER_CONFIG } from '@/lib/orders/config';
import { OrdersPage } from '@/components/orders/orders';

export default function PurchaseOrdersPage() {
  return <OrdersPage cfg={PURCHASE_ORDER_CONFIG} />;
}
