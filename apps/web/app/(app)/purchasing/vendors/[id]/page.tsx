'use client';
import { useParams } from 'next/navigation';
import { AP_CONFIG } from '@/lib/subledger/config';
import { PartyDetailPage } from '@/components/subledger/party-detail';

export default function ApPartyPage() {
  const params = useParams<{ id: string }>();
  return <PartyDetailPage cfg={AP_CONFIG} id={params.id} />;
}
