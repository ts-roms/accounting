'use client';
import { useParams } from 'next/navigation';
import { FixedAssetDetailPage } from '@/components/fixed-assets/asset-detail';

export default function FixedAssetRoute() {
  const params = useParams<{ id: string }>();
  return <FixedAssetDetailPage id={params.id} />;
}
