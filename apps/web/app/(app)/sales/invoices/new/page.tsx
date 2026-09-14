'use client';
import { Suspense } from 'react';
import { AR_CONFIG } from '@/lib/subledger/config';
import { NewDocumentScreen } from '@/components/subledger/editors';

export default function ArNewDocumentPage() {
  return (
    <Suspense>
      <NewDocumentScreen cfg={AR_CONFIG} />
    </Suspense>
  );
}
