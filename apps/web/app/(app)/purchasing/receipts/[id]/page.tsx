'use client';
import { useParams } from 'next/navigation';
import { GoodsReceiptDetailPage } from '@/components/orders/goods-receipts';

export default function GoodsReceiptPage() {
  const params = useParams<{ id: string }>();
  return <GoodsReceiptDetailPage id={params.id} />;
}
