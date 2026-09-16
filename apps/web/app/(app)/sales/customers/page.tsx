'use client';
import * as React from 'react';
import { AR_CONFIG } from '@/lib/subledger/config';
import { PartiesPage } from '@/components/subledger/parties';

export default function ArPartiesPage() {
  return (
    <React.Suspense fallback={null}>
      <PartiesPage cfg={AR_CONFIG} />
    </React.Suspense>
  );
}
