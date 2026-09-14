'use client';
import { useParams } from 'next/navigation';
import { PURCHASE_REQUEST_CONFIG } from '@/lib/orders/config';
import { OrderDetailPage } from '@/components/orders/order-detail';

export default function PurchaseRequestPage() {
  const params = useParams<{ id: string }>();
  return <OrderDetailPage cfg={PURCHASE_REQUEST_CONFIG} id={params.id} />;
}
