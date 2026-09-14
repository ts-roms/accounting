'use client';
import { useParams } from 'next/navigation';
import { AP_CONFIG } from '@/lib/subledger/config';
import { EditDocumentScreen } from '@/components/subledger/editors';

export default function ApEditDocumentPage() {
  const params = useParams<{ id: string }>();
  return <EditDocumentScreen cfg={AP_CONFIG} id={params.id} />;
}
