'use client';
import { Suspense } from 'react';
import { VariancePage } from '@/components/budgeting/variance';

export default function VarianceRoute() {
  return (
    <Suspense>
      <VariancePage />
    </Suspense>
  );
}
