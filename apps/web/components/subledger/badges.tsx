'use client';
import type { AccountingStatus, PaymentStatus, SubledgerDocumentStatus } from '@accounting/types';
import { Badge, StatusBadge } from '@accounting/ui';
import { toneOf } from '@/components/status';

const DOC_VARIANT: Record<
  SubledgerDocumentStatus,
  'secondary' | 'default' | 'warning' | 'success' | 'destructive'
> = {
  DRAFT: 'secondary',
  APPROVED: 'default',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
  VOID: 'destructive',
};

/** Business status, with the accounting status as a secondary marker (kept separate on purpose). */
export function DocumentStatusBadge({
  status,
  accountingStatus,
}: {
  status: SubledgerDocumentStatus;
  accountingStatus?: AccountingStatus;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <StatusBadge tone={toneOf(DOC_VARIANT[status])}>{status.replace('_', ' ')}</StatusBadge>
      {accountingStatus && accountingStatus !== 'POSTED' && status !== 'DRAFT' ? (
        <Badge variant="outline" className="text-[10px]">
          {accountingStatus}
        </Badge>
      ) : null}
    </span>
  );
}

const PAY_VARIANT: Record<PaymentStatus, 'secondary' | 'success' | 'destructive'> = {
  DRAFT: 'secondary',
  POSTED: 'success',
  VOID: 'destructive',
};

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <StatusBadge tone={toneOf(PAY_VARIANT[status])}>{status}</StatusBadge>;
}
