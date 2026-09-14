'use client';
import { useParams } from 'next/navigation';
import { QUOTATION_CONFIG } from '@/lib/orders/config';
import { OrderDetailPage } from '@/components/orders/order-detail';

export default function QuotationPage() {
  const params = useParams<{ id: string }>();
  return <OrderDetailPage cfg={QUOTATION_CONFIG} id={params.id} />;
}
