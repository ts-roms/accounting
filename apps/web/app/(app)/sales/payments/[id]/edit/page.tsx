'use client';
import { useParams } from 'next/navigation';
import { AR_CONFIG } from '@/lib/subledger/config';
import { EditPaymentScreen } from '@/components/subledger/editors';

export default function ArEditPaymentPage() {
  const params = useParams<{ id: string }>();
  return <EditPaymentScreen cfg={AR_CONFIG} id={params.id} />;
}
