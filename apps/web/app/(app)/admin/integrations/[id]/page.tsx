'use client';
import * as React from 'react';
import { useParams } from 'next/navigation';
import { IntegrationDetailPage } from '@/components/integrations/integration-detail';

export default function IntegrationDetailRoute() {
  const params = useParams<{ id: string }>();
  return (
    <React.Suspense fallback={null}>
      <IntegrationDetailPage id={params.id} />
    </React.Suspense>
  );
}
