'use client';
import { AR_CONFIG } from '@/lib/subledger/config';
import { PaymentsPage } from '@/components/subledger/payments';

export default function ArPaymentsPage() {
  return <PaymentsPage cfg={AR_CONFIG} />;
}
