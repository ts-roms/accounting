'use client';
import { useParams } from 'next/navigation';
import { FinancialCloseDetailPage } from '@/components/controls/financial-close';

export default function FinancialCloseDetailRoute() {
  const params = useParams<{ id: string }>();
  return <FinancialCloseDetailPage id={params.id} />;
}
