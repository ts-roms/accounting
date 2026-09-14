'use client';
import { Suspense } from 'react';
import { BankStatementsPage } from '@/components/banking/statements';

export default function BankStatementsRoute() {
  return (
    <Suspense>
      <BankStatementsPage />
    </Suspense>
  );
}
