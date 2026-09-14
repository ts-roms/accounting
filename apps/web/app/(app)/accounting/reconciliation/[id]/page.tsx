'use client';
import { useParams } from 'next/navigation';
import { ReconciliationDetailPage } from '@/components/controls/reconciliation-detail';

export default function ReconciliationDetailRoute() {
  const params = useParams<{ id: string }>();
  return <ReconciliationDetailPage id={params.id} />;
}
