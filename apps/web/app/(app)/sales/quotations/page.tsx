'use client';
import { QUOTATION_CONFIG } from '@/lib/orders/config';
import { OrdersPage } from '@/components/orders/orders';

export default function QuotationsPage() {
  return <OrdersPage cfg={QUOTATION_CONFIG} />;
}
