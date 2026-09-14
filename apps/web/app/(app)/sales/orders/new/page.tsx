'use client';
import { Suspense } from 'react';
import { SALES_ORDER_CONFIG } from '@/lib/orders/config';
import { NewOrderScreen } from '@/components/orders/editors';

export default function NewSalesOrderPage() {
  return (
    <Suspense>
      <NewOrderScreen cfg={SALES_ORDER_CONFIG} />
    </Suspense>
  );
}
