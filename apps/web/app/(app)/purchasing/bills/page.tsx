'use client';
import { AP_CONFIG } from '@/lib/subledger/config';
import { DocumentsPage } from '@/components/subledger/documents';

export default function ApDocumentsPage() {
  return <DocumentsPage cfg={AP_CONFIG} />;
}
