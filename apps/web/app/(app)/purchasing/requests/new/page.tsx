'use client';
import { Suspense } from 'react';
import { PURCHASE_REQUEST_CONFIG } from '@/lib/orders/config';
import { NewOrderScreen } from '@/components/orders/editors';

export default function NewPurchaseRequestPage() {
  return (
    <Suspense>
      <NewOrderScreen cfg={PURCHASE_REQUEST_CONFIG} />
    </Suspense>
  );
}
