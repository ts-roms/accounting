'use client';
import * as React from 'react';
import { Card, CardContent, StatusBadge } from '@accounting/ui';
import type { AssetStatus, DepreciationRunStatus } from '@accounting/types';
import { titleCase } from '@/lib/format';
import { toneOf } from '@/components/status';

export const ASSETS_PATH = '/fixed-assets/assets';
export const DEPRECIATION_PATH = '/fixed-assets/depreciation';

const ASSET_VARIANT: Record<
  AssetStatus,
  'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  DRAFT: 'secondary',
  ACTIVE: 'success',
  FULLY_DEPRECIATED: 'warning',
  DISPOSED: 'outline',
  WRITTEN_OFF: 'destructive',
};

export function AssetStatusBadge({ status }: { status: AssetStatus }) {
  return <StatusBadge tone={toneOf(ASSET_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

const RUN_VARIANT: Record<DepreciationRunStatus, 'secondary' | 'success' | 'outline'> = {
  DRAFT: 'secondary',
  POSTED: 'success',
  REVERSED: 'outline',
};

export function RunStatusBadge({ status }: { status: DepreciationRunStatus }) {
  return <StatusBadge tone={toneOf(RUN_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

export function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export function Stat({
  label,
  value,
  hint,
  danger,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="type-label">{label}</div>
        <div className={`mt-1 text-lg font-semibold tabular ${danger ? 'text-critical' : ''}`}>
          {value}
        </div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

export function methodLabel(method: string, rate: string | null): string {
  if (method === 'DECLINING_BALANCE') return `Declining balance${rate ? ` ${Number(rate)}%` : ''}`;
  return 'Straight line';
}
