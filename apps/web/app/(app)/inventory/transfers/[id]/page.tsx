'use client';
import { useParams } from 'next/navigation';
import { TRANSFERS_CONFIG, StockDocumentDetailPage } from '@/components/inventory/stock-documents';

export default function StockTransferPage() {
  const params = useParams<{ id: string }>();
  return <StockDocumentDetailPage cfg={TRANSFERS_CONFIG} id={params.id} />;
}
