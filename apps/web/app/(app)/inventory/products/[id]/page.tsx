'use client';
import { useParams } from 'next/navigation';
import { ProductDetailPage } from '@/components/inventory/products';

export default function InventoryProductPage() {
  const params = useParams<{ id: string }>();
  return <ProductDetailPage id={params.id} />;
}
