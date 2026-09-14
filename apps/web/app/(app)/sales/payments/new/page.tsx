'use client';
import { Suspense } from 'react';
import { AR_CONFIG } from '@/lib/subledger/config';
import { NewPaymentScreen } from '@/components/subledger/editors';

export default function ArNewPaymentPage() {
  return (
    <Suspense>
      <NewPaymentScreen cfg={AR_CONFIG} />
    </Suspense>
  );
}
