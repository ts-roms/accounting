'use client';
import { useParams } from 'next/navigation';
import { ReconciliationPage } from '@/components/banking/reconciliation';

export default function ReconciliationRoute() {
  const params = useParams<{ id: string }>();
  return <ReconciliationPage id={params.id} />;
}
