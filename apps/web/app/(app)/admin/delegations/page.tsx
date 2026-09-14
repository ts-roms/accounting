'use client';
import * as React from 'react';
import { DelegationsPage } from '@/components/delegations/delegations';

export default function DelegationsRoute() {
  return (
    <React.Suspense fallback={null}>
      <DelegationsPage />
    </React.Suspense>
  );
}
