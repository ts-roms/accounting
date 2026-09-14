'use client';
import { TRANSFERS_CONFIG, NewStockDocumentScreen } from '@/components/inventory/stock-documents';

export default function NewStockTransferPage() {
  return <NewStockDocumentScreen cfg={TRANSFERS_CONFIG} />;
}
