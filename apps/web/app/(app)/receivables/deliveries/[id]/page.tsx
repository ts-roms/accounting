'use client';
import { useParams } from 'next/navigation';
import { DeliveryDetailPage } from '@/components/receivables/deliveries';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <DeliveryDetailPage id={params.id} />;
}
