'use client';
import * as React from 'react';
import { CustomReportsPage } from '@/components/reporting/custom-reports';

export default function CustomReportsRoute() {
  return (
    <React.Suspense>
      <CustomReportsPage />
    </React.Suspense>
  );
}
