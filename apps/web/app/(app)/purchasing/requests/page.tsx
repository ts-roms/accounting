'use client';
import { PURCHASE_REQUEST_CONFIG } from '@/lib/orders/config';
import { OrdersPage } from '@/components/orders/orders';

export default function PurchaseRequestsPage() {
  return <OrdersPage cfg={PURCHASE_REQUEST_CONFIG} />;
}
