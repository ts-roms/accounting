'use client';
import { SALES_RETURNS_CONFIG } from '@/lib/orders/config';
import { ReturnsPage } from '@/components/orders/returns';

export default function SalesReturnsPage() {
  return <ReturnsPage cfg={SALES_RETURNS_CONFIG} />;
}
