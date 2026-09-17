'use client';
import { useParams } from 'next/navigation';
import { LeaseDetailPage } from '@/components/leases/lease-detail';

export default function LeaseRoute() {
  const params = useParams<{ id: string }>();
  return <LeaseDetailPage id={params.id} />;
}
