'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { AiForecastPage } from '@/components/ai/forecast';

function Content() {
  const params = useSearchParams();
  return <AiForecastPage initialMetric={params.get('metric') ?? undefined} />;
}

export default function AiForecastRoute() {
  return (
    <React.Suspense>
      <Content />
    </React.Suspense>
  );
}
