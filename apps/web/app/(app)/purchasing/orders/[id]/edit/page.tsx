'use client';
import { useParams } from 'next/navigation';
import { PURCHASE_ORDER_CONFIG } from '@/lib/orders/config';
import { EditOrderScreen } from '@/components/orders/editors';

export default function EditPurchaseOrderPage() {
  const params = useParams<{ id: string }>();
  return <EditOrderScreen cfg={PURCHASE_ORDER_CONFIG} id={params.id} />;
}
