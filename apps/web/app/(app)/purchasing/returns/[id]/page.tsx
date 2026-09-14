'use client';
import { useParams } from 'next/navigation';
import { PURCHASE_RETURNS_CONFIG } from '@/lib/orders/config';
import { ReturnDetailPage } from '@/components/orders/returns';

export default function PurchaseReturnPage() {
  const params = useParams<{ id: string }>();
  return <ReturnDetailPage cfg={PURCHASE_RETURNS_CONFIG} id={params.id} />;
}
