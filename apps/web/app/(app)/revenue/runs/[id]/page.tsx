'use client';
import { useParams } from 'next/navigation';
import { RevenueRunDetailPage } from '@/components/revenue/runs';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <RevenueRunDetailPage id={params.id} />;
}
