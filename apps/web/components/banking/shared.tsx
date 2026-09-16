'use client';
import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from '@accounting/ui';
import type {
  BankTransactionStatus,
  BankTransactionType,
  StatementLineStatus,
  StatementStatus,
} from '@accounting/types';
import { useBankAccounts } from '@/lib/api/assets-banking-hooks';
import { titleCase } from '@/lib/format';
import { toneOf } from '@/components/status';

export const ACCOUNTS_PATH = '/banking/accounts';
export const TRANSACTIONS_PATH = '/banking/transactions';
export const RECONCILIATION_PATH = '/banking/reconciliation';

const TX_VARIANT: Record<BankTransactionStatus, 'secondary' | 'success' | 'destructive'> = {
  DRAFT: 'secondary',
  POSTED: 'success',
  VOID: 'destructive',
};
export function TxStatusBadge({ status }: { status: BankTransactionStatus }) {
  return <StatusBadge tone={toneOf(TX_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

const LINE_VARIANT: Record<
  StatementLineStatus,
  'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  UNMATCHED: 'warning',
  POSSIBLE_MATCH: 'secondary',
  MATCHED: 'success',
  DUPLICATE: 'outline',
  EXCEPTION: 'destructive',
  RECONCILED: 'success',
};
export function LineStatusBadge({ status }: { status: StatementLineStatus }) {
  return <StatusBadge tone={toneOf(LINE_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

export function StatementStatusBadge({ status }: { status: StatementStatus }) {
  return (
    <StatusBadge tone={toneOf(status === 'RECONCILED' ? 'success' : 'warning')}>
      {titleCase(status)}
    </StatusBadge>
  );
}

/** Money in for deposits / interest / transfer-in; out for the rest. */
export const MONEY_IN: Record<BankTransactionType, boolean> = {
  DEPOSIT: true,
  INTEREST: true,
  WITHDRAWAL: false,
  BANK_FEE: false,
  TRANSFER: false,
};

export function BankAccountSelect({
  value,
  onChange,
  allowAll,
  disabled,
  excludeId,
  className,
  testId,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  allowAll?: string;
  disabled?: boolean;
  excludeId?: string | null;
  className?: string;
  testId?: string;
}) {
  const accounts = useBankAccounts();
  return (
    <Select
      value={value ?? (allowAll ? 'ALL' : '')}
      onValueChange={(v) => onChange(v === 'ALL' ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className={className} data-testid={testId}>
        <SelectValue placeholder="Bank account" />
      </SelectTrigger>
      <SelectContent>
        {allowAll ? <SelectItem value="ALL">{allowAll}</SelectItem> : null}
        {accounts.data
          ?.filter((a) => a.id !== excludeId && (a.status === 'ACTIVE' || a.id === value))
          .map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.code} · {a.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
