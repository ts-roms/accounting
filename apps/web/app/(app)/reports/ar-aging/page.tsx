'use client';
import { AR_CONFIG } from '@/lib/subledger/config';
import { AgingPage } from '@/components/subledger/aging';

export default function ArAgingPage() {
  return <AgingPage cfg={AR_CONFIG} />;
}
