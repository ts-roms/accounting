'use client';
import { useParams } from 'next/navigation';
import { AP_CONFIG } from '@/lib/subledger/config';
import { DocumentDetailPage } from '@/components/subledger/document-detail';

export default function ApDocumentPage() {
  const params = useParams<{ id: string }>();
  return <DocumentDetailPage cfg={AP_CONFIG} id={params.id} />;
}
