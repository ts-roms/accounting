'use client';
import { useParams } from 'next/navigation';
import { RevenueScheduleDetailPage } from '@/components/revenue/schedules';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <RevenueScheduleDetailPage id={params.id} />;
}
