'use client';
import { useParams } from 'next/navigation';
import { PaymentRunDetailPage } from '@/components/payables/payment-runs';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <PaymentRunDetailPage id={params.id} />;
}
