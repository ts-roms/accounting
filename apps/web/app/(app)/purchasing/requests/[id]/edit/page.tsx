'use client';
import { useParams } from 'next/navigation';
import { PURCHASE_REQUEST_CONFIG } from '@/lib/orders/config';
import { EditOrderScreen } from '@/components/orders/editors';

export default function EditPurchaseRequestPage() {
  const params = useParams<{ id: string }>();
  return <EditOrderScreen cfg={PURCHASE_REQUEST_CONFIG} id={params.id} />;
}
