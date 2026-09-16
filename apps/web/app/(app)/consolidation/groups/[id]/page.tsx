'use client';
import { useParams } from 'next/navigation';
import { ConsolidationGroupDetailPage } from '@/components/consolidation/groups';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <ConsolidationGroupDetailPage id={params.id} />;
}
