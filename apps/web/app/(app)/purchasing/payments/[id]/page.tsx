'use client';
import { useParams } from 'next/navigation';
import { AP_CONFIG } from '@/lib/subledger/config';
import { PaymentDetailPage } from '@/components/subledger/payment-detail';

export default function ApPaymentPage() {
  const params = useParams<{ id: string }>();
  return <PaymentDetailPage cfg={AP_CONFIG} id={params.id} />;
}
