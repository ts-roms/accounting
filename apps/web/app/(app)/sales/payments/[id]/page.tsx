'use client';
import { useParams } from 'next/navigation';
import { AR_CONFIG } from '@/lib/subledger/config';
import { PaymentDetailPage } from '@/components/subledger/payment-detail';

export default function ArPaymentPage() {
  const params = useParams<{ id: string }>();
  return <PaymentDetailPage cfg={AR_CONFIG} id={params.id} />;
}
