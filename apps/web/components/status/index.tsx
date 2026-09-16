'use client';
/*
 * Domain status components. Each maps a business enum to a semantic tone and
 * renders <StatusBadge> (tone + icon/dot + text). Module files may keep their
 * own variant maps; `toneOf` converts the legacy Badge variant names so every
 * status in the app shares one visual language.
 */
import * as React from 'react';
import type {
  AccountingStatus,
  ApprovalRequestStatus,
  FiscalPeriodStatus,
  IntegrationStatus as IntegrationStatusKey,
  JournalStatus as JournalStatusKey,
  PaymentStatus as PaymentStatusKey,
  SubledgerReconciliationStatus,
} from '@accounting/types';
import { StatusBadge, type StatusBadgeProps, type Tone } from '@accounting/ui';
import { titleCase } from '@/lib/format';

export type LegacyVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'success'
  | 'warning'
  | 'outline'
  | 'positive'
  | 'critical'
  | 'info'
  | 'neutral';

const LEGACY_TONE: Record<LegacyVariant, Tone> = {
  default: 'info',
  secondary: 'pending',
  destructive: 'critical',
  success: 'positive',
  warning: 'warning',
  outline: 'neutral',
  positive: 'positive',
  critical: 'critical',
  info: 'info',
  neutral: 'neutral',
};

/** Legacy Badge variant name -> semantic tone. */
export const toneOf = (variant: LegacyVariant): Tone => LEGACY_TONE[variant];

type Props = Omit<StatusBadgeProps, 'tone' | 'children'> & { label?: React.ReactNode };

function make<T extends string>(name: string, tones: Record<T, Tone>, active?: T[]) {
  const C = ({ status, label, ...rest }: Props & { status: T }) => (
    <StatusBadge tone={tones[status]} active={active?.includes(status)} {...rest}>
      {label ?? titleCase(status)}
    </StatusBadge>
  );
  C.displayName = name;
  return C;
}

/** Journal / document accounting status: UNPOSTED, POSTED, REVERSED. */
export const FinancialStatus = make<AccountingStatus>('FinancialStatus', {
  UNPOSTED: 'pending',
  POSTED: 'positive',
  REVERSED: 'neutral',
});

export const JournalStatus = make<JournalStatusKey>('JournalStatus', {
  DRAFT: 'pending',
  SUBMITTED: 'warning',
  APPROVED: 'info',
  POSTED: 'positive',
  LOCKED: 'positive',
  REJECTED: 'critical',
  REVERSED: 'neutral',
});

export const ApprovalStatus = make<ApprovalRequestStatus>('ApprovalStatus', {
  PENDING: 'warning',
  APPROVED: 'positive',
  REJECTED: 'critical',
  CANCELLED: 'neutral',
});

export const PaymentStatus = make<PaymentStatusKey>('PaymentStatus', {
  DRAFT: 'pending',
  POSTED: 'positive',
  VOID: 'critical',
});

export const ReconciliationStatus = make<SubledgerReconciliationStatus>('ReconciliationStatus', {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'pending',
  RECONCILED: 'positive',
  HAS_VARIANCE: 'critical',
  UNDER_REVIEW: 'warning',
  APPROVED: 'positive',
});

export const IntegrationStatus = make<IntegrationStatusKey>(
  'IntegrationStatus',
  {
    CONNECTED: 'positive',
    DISCONNECTED: 'neutral',
    CONNECTING: 'pending',
    SYNCING: 'info',
    ERROR: 'critical',
    DISABLED: 'neutral',
  },
  ['SYNCING', 'CONNECTING'],
);

export const PeriodStatus = make<FiscalPeriodStatus>('PeriodStatus', {
  OPEN: 'positive',
  SOFT_CLOSED: 'warning',
  CLOSED: 'neutral',
  LOCKED: 'neutral',
});

export { HealthIndicator, StatusBadge, StatusDot } from '@accounting/ui';
