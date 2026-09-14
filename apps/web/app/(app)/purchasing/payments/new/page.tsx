'use client';
import { Suspense } from 'react';
import { AP_CONFIG } from '@/lib/subledger/config';
import { NewPaymentScreen } from '@/components/subledger/editors';

export default function ApNewPaymentPage() {
  return (
    <Suspense>
      <NewPaymentScreen cfg={AP_CONFIG} />
    </Suspense>
  );
}
