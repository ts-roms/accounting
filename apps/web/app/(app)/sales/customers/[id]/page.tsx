'use client';
import { useParams } from 'next/navigation';
import { AR_CONFIG } from '@/lib/subledger/config';
import { PartyDetailPage } from '@/components/subledger/party-detail';

export default function ArPartyPage() {
  const params = useParams<{ id: string }>();
  return <PartyDetailPage cfg={AR_CONFIG} id={params.id} />;
}
