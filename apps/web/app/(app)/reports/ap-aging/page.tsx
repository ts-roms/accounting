'use client';
import { AP_CONFIG } from '@/lib/subledger/config';
import { AgingPage } from '@/components/subledger/aging';

export default function ApAgingPage() {
  return <AgingPage cfg={AP_CONFIG} />;
}
