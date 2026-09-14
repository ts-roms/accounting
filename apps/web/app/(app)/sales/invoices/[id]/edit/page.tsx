'use client';
import { useParams } from 'next/navigation';
import { AR_CONFIG } from '@/lib/subledger/config';
import { EditDocumentScreen } from '@/components/subledger/editors';

export default function ArEditDocumentPage() {
  const params = useParams<{ id: string }>();
  return <EditDocumentScreen cfg={AR_CONFIG} id={params.id} />;
}
