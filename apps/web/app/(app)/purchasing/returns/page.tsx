'use client';
import { PURCHASE_RETURNS_CONFIG } from '@/lib/orders/config';
import { ReturnsPage } from '@/components/orders/returns';

export default function PurchaseReturnsPage() {
  return <ReturnsPage cfg={PURCHASE_RETURNS_CONFIG} />;
}
