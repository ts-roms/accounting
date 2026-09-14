'use client';
import { useParams } from 'next/navigation';
import { AiDocumentPage } from '@/components/ai/intake';

export default function AiDocumentRoute() {
  const params = useParams<{ id: string }>();
  return <AiDocumentPage id={params.id} />;
}
