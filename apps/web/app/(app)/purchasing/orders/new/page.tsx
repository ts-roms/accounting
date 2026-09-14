'use client';
import { Suspense } from 'react';
import { PURCHASE_ORDER_CONFIG } from '@/lib/orders/config';
import { NewOrderScreen } from '@/components/orders/editors';

export default function NewPurchaseOrderPage() {
  return (
    <Suspense>
      <NewOrderScreen cfg={PURCHASE_ORDER_CONFIG} />
    </Suspense>
  );
}
