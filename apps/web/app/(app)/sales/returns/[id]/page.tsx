'use client';
import { useParams } from 'next/navigation';
import { SALES_RETURNS_CONFIG } from '@/lib/orders/config';
import { ReturnDetailPage } from '@/components/orders/returns';

export default function SalesReturnPage() {
  const params = useParams<{ id: string }>();
  return <ReturnDetailPage cfg={SALES_RETURNS_CONFIG} id={params.id} />;
}
