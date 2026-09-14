'use client';
import { AP_CONFIG } from '@/lib/subledger/config';
import { PartiesPage } from '@/components/subledger/parties';

export default function ApPartiesPage() {
  return <PartiesPage cfg={AP_CONFIG} />;
}
