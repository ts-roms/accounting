'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { AiAnomaliesPage } from '@/components/ai/anomalies';

function Content() {
  const params = useSearchParams();
  return <AiAnomaliesPage initialSeverity={params.get('severity') ?? undefined} />;
}

export default function AiAnomaliesRoute() {
  return (
    <React.Suspense>
      <Content />
    </React.Suspense>
  );
}
