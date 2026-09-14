'use client';
import { Suspense } from 'react';
import { QUOTATION_CONFIG } from '@/lib/orders/config';
import { NewOrderScreen } from '@/components/orders/editors';

export default function NewQuotationPage() {
  return (
    <Suspense>
      <NewOrderScreen cfg={QUOTATION_CONFIG} />
    </Suspense>
  );
}
