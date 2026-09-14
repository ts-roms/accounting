'use client';
import { Suspense } from 'react';
import { BankTransactionsPage } from '@/components/banking/transactions';

export default function BankTransactionsRoute() {
  return (
    <Suspense>
      <BankTransactionsPage />
    </Suspense>
  );
}
