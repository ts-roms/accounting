'use client';
import { useParams } from 'next/navigation';
import { COUNTS_CONFIG, StockDocumentDetailPage } from '@/components/inventory/stock-documents';

export default function StockCountPage() {
  const params = useParams<{ id: string }>();
  return <StockDocumentDetailPage cfg={COUNTS_CONFIG} id={params.id} />;
}
