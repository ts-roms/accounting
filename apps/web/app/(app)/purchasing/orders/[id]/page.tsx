'use client';
import { useParams } from 'next/navigation';
import { PURCHASE_ORDER_CONFIG } from '@/lib/orders/config';
import { OrderDetailPage } from '@/components/orders/order-detail';

export default function PurchaseOrderPage() {
  const params = useParams<{ id: string }>();
  return <OrderDetailPage cfg={PURCHASE_ORDER_CONFIG} id={params.id} />;
}
