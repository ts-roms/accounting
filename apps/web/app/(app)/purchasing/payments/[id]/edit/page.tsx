'use client';
import { useParams } from 'next/navigation';
import { AP_CONFIG } from '@/lib/subledger/config';
import { EditPaymentScreen } from '@/components/subledger/editors';

export default function ApEditPaymentPage() {
  const params = useParams<{ id: string }>();
  return <EditPaymentScreen cfg={AP_CONFIG} id={params.id} />;
}
