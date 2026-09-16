'use client';
import { useParams } from 'next/navigation';
import { ConsolidationRunDetailPage } from '@/components/consolidation/runs';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <ConsolidationRunDetailPage id={params.id} />;
}
