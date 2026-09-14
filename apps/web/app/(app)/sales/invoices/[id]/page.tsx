'use client';
import { useParams } from 'next/navigation';
import { AR_CONFIG } from '@/lib/subledger/config';
import { DocumentDetailPage } from '@/components/subledger/document-detail';

export default function ArDocumentPage() {
  const params = useParams<{ id: string }>();
  return <DocumentDetailPage cfg={AR_CONFIG} id={params.id} />;
}
