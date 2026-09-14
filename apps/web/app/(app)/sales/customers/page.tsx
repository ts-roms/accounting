'use client';
import { AR_CONFIG } from '@/lib/subledger/config';
import { PartiesPage } from '@/components/subledger/parties';

export default function ArPartiesPage() {
  return <PartiesPage cfg={AR_CONFIG} />;
}
