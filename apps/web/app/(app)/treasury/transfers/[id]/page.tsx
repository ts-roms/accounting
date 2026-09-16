'use client';
import { useParams } from 'next/navigation';
import { BankTransferDetailPage } from '@/components/treasury/transfers';

export default function Page() {
  const params = useParams<{ id: string }>();
  return <BankTransferDetailPage id={params.id} />;
}
