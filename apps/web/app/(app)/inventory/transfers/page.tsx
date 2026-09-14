'use client';
import { TRANSFERS_CONFIG, StockDocumentsPage } from '@/components/inventory/stock-documents';

export default function StockTransfersPage() {
  return <StockDocumentsPage cfg={TRANSFERS_CONFIG} />;
}
