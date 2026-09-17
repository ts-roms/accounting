'use client';
import { useParams } from 'next/navigation';
import { PayslipPage } from '@/components/payroll/pay-runs';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <PayslipPage id={params.id} />;
}
