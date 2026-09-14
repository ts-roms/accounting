'use client';
import { Suspense } from 'react';
import { ImportStatementPage } from '@/components/banking/statements';

export default function ImportStatementRoute() {
  return (
    <Suspense>
      <ImportStatementPage />
    </Suspense>
  );
}
