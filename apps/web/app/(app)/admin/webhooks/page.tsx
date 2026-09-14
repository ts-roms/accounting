'use client';
import * as React from 'react';
import { WebhooksPage } from '@/components/integrations/webhooks';

export default function WebhooksRoute() {
  return (
    <React.Suspense fallback={null}>
      <WebhooksPage />
    </React.Suspense>
  );
}
