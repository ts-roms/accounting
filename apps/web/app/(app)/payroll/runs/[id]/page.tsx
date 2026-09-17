'use client';
import { useParams } from 'next/navigation';
import { PayRunDetailPage } from '@/components/payroll/pay-runs';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <PayRunDetailPage id={params.id} />;
}
