'use client';
import type {
  FulfillmentStatus,
  GoodsReceiptStatus,
  MatchStatus,
  OrderStatus,
  ReturnStatus,
} from '@accounting/types';
import { Badge } from '@accounting/ui';

type Variant = 'secondary' | 'default' | 'warning' | 'success' | 'destructive' | 'outline';

const ORDER_VARIANT: Record<OrderStatus, Variant> = {
  DRAFT: 'secondary',
  SUBMITTED: 'warning',
  SENT: 'warning',
  ACCEPTED: 'default',
  APPROVED: 'default',
  CONVERTED: 'success',
  REJECTED: 'destructive',
  CLOSED: 'success',
  CANCELLED: 'destructive',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge variant={ORDER_VARIANT[status]}>{status}</Badge>;
}

const FULFILMENT_VARIANT: Record<FulfillmentStatus, Variant> = {
  NONE: 'outline',
  PARTIAL: 'warning',
  FULL: 'success',
};

/** Receiving / invoicing / billing progress. */
export function FulfillmentBadge({ status, label }: { status: FulfillmentStatus; label: string }) {
  return (
    <Badge variant={FULFILMENT_VARIANT[status]} className="text-[10px]">
      {label}: {status === 'NONE' ? 'none' : status.toLowerCase()}
    </Badge>
  );
}

const MATCH_VARIANT: Record<MatchStatus, Variant> = {
  NOT_REQUIRED: 'outline',
  MATCHED: 'success',
  EXCEPTION: 'destructive',
  REVIEWED: 'warning',
};

export function MatchStatusBadge({ status }: { status: MatchStatus }) {
  return (
    <Badge variant={MATCH_VARIANT[status]} data-testid="match-status">
      {status === 'NOT_REQUIRED'
        ? 'No PO match'
        : status === 'EXCEPTION'
          ? 'Match exception'
          : status === 'REVIEWED'
            ? 'Exception reviewed'
            : 'Matched'}
    </Badge>
  );
}

const RECEIPT_VARIANT: Record<GoodsReceiptStatus, Variant> = {
  DRAFT: 'secondary',
  CONFIRMED: 'success',
  CANCELLED: 'destructive',
};

export function ReceiptStatusBadge({ status }: { status: GoodsReceiptStatus }) {
  return <Badge variant={RECEIPT_VARIANT[status]}>{status}</Badge>;
}

const RETURN_VARIANT: Record<ReturnStatus, Variant> = {
  DRAFT: 'secondary',
  APPROVED: 'default',
  CREDITED: 'success',
  CANCELLED: 'destructive',
};

export function ReturnStatusBadge({ status }: { status: ReturnStatus }) {
  return <Badge variant={RETURN_VARIANT[status]}>{status}</Badge>;
}
