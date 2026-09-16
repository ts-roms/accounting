'use client';
import { useParams } from 'next/navigation';
import { CollectionCaseDetailPage } from '@/components/receivables/collections';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <CollectionCaseDetailPage id={params.id} />;
}
