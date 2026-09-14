'use client';
import { useParams } from 'next/navigation';
import { QUOTATION_CONFIG } from '@/lib/orders/config';
import { EditOrderScreen } from '@/components/orders/editors';

export default function EditQuotationPage() {
  const params = useParams<{ id: string }>();
  return <EditOrderScreen cfg={QUOTATION_CONFIG} id={params.id} />;
}
