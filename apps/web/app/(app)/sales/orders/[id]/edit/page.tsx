'use client';
import { useParams } from 'next/navigation';
import { SALES_ORDER_CONFIG } from '@/lib/orders/config';
import { EditOrderScreen } from '@/components/orders/editors';

export default function EditSalesOrderPage() {
  const params = useParams<{ id: string }>();
  return <EditOrderScreen cfg={SALES_ORDER_CONFIG} id={params.id} />;
}
