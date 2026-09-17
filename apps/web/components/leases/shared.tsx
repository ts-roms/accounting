'use client';
import * as React from 'react';
import { Card, CardContent, StatusBadge } from '@accounting/ui';
import type {
  LeaseClassification,
  LeaseLineStatus,
  LeaseRunStatus,
  LeaseStatus,
} from '@accounting/types';
import { titleCase } from '@/lib/format';
import { toneOf } from '@/components/status';

export const LEASES_PATH = '/leases';
export const LEASE_RUNS_PATH = '/leases/runs';
export const LEASE_REPORTS_PATH = '/leases/reports';

type Variant = 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' | 'default';

const LEASE_VARIANT: Record<LeaseStatus, Variant> = {
  DRAFT: 'secondary',
  ACTIVE: 'success',
  COMPLETED: 'outline',
  TERMINATED: 'destructive',
};
const LINE_VARIANT: Record<LeaseLineStatus, Variant> = {
  PENDING: 'secondary',
  POSTED: 'success',
  CANCELLED: 'outline',
};
const RUN_VARIANT: Record<LeaseRunStatus, Variant> = { POSTED: 'success', REVERSED: 'outline' };
const CLASS_VARIANT: Record<LeaseClassification, Variant> = {
  FINANCE: 'default',
  SHORT_TERM: 'warning',
  LOW_VALUE: 'warning',
};

export const CLASSIFICATION_LABEL: Record<LeaseClassification, string> = {
  FINANCE: 'On balance sheet',
  SHORT_TERM: 'Short-term (exempt)',
  LOW_VALUE: 'Low-value (exempt)',
};

export function LeaseStatusBadge({ status }: { status: LeaseStatus }) {
  return <StatusBadge tone={toneOf(LEASE_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

export function LineStatusBadge({ status }: { status: LeaseLineStatus }) {
  return <StatusBadge tone={toneOf(LINE_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

export function LeaseRunStatusBadge({ status }: { status: LeaseRunStatus }) {
  return <StatusBadge tone={toneOf(RUN_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

export function ClassificationBadge({ classification }: { classification: LeaseClassification }) {
  return (
    <StatusBadge tone={toneOf(CLASS_VARIANT[classification])}>
      {CLASSIFICATION_LABEL[classification]}
    </StatusBadge>
  );
}

export function Stat({
  label,
  value,
  hint,
  danger,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <Card data-testid={testId}>
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

export function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export const frequencyLabel = (f: string) =>
  f === 'MONTHLY' ? 'monthly' : f === 'QUARTERLY' ? 'quarterly' : 'annual';
export const timingLabel = (t: string) => (t === 'IN_ADVANCE' ? 'in advance' : 'in arrears');
