'use client';
import { Suspense } from 'react';
import { AP_CONFIG } from '@/lib/subledger/config';
import { NewDocumentScreen } from '@/components/subledger/editors';

export default function ApNewDocumentPage() {
  return (
    <Suspense>
      <NewDocumentScreen cfg={AP_CONFIG} />
    </Suspense>
  );
}
