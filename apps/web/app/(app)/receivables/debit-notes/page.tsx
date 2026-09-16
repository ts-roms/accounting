'use client';
import { AR_CONFIG } from '@/lib/subledger/config';
import { DocumentsPage } from '@/components/subledger/documents';

export default function Page() {
  return <DocumentsPage cfg={AR_CONFIG} initialType="DEBIT_NOTE" />;
}
