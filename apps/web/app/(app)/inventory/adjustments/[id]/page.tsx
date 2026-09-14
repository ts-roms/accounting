'use client';
import { useParams } from 'next/navigation';
import {
  ADJUSTMENTS_CONFIG,
  StockDocumentDetailPage,
} from '@/components/inventory/stock-documents';

export default function StockAdjustmentPage() {
  const params = useParams<{ id: string }>();
  return <StockDocumentDetailPage cfg={ADJUSTMENTS_CONFIG} id={params.id} />;
}
