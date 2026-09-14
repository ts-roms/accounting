'use client';
import { AP_CONFIG } from '@/lib/subledger/config';
import { PaymentsPage } from '@/components/subledger/payments';

export default function ApPaymentsPage() {
  return <PaymentsPage cfg={AP_CONFIG} />;
}
