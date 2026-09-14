'use client';
import * as React from 'react';
import { ApiKeysPage } from '@/components/integrations/api-keys';

export default function ApiKeysRoute() {
  return (
    <React.Suspense fallback={null}>
      <ApiKeysPage />
    </React.Suspense>
  );
}
