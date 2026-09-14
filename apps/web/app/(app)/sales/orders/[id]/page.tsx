'use client';
import { useParams } from 'next/navigation';
import { SALES_ORDER_CONFIG } from '@/lib/orders/config';
import { OrderDetailPage } from '@/components/orders/order-detail';

export default function SalesOrderPage() {
  const params = useParams<{ id: string }>();
  return <OrderDetailPage cfg={SALES_ORDER_CONFIG} id={params.id} />;
}
