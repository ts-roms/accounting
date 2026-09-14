'use client';
import * as React from 'react';
import { IntegrationsPage } from '@/components/integrations/integrations';

export default function IntegrationsRoute() {
  return (
    <React.Suspense fallback={null}>
      <IntegrationsPage />
    </React.Suspense>
  );
}
