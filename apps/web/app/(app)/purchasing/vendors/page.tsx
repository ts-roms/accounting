'use client';
import * as React from 'react';
import { AP_CONFIG } from '@/lib/subledger/config';
import { PartiesPage } from '@/components/subledger/parties';

export default function ApPartiesPage() {
  return (
    <React.Suspense fallback={null}>
      <PartiesPage cfg={AP_CONFIG} />
    </React.Suspense>
  );
}
