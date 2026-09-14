'use client';
import * as React from 'react';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import type {
  BankTransactionStatus,
  BankTransactionType,
  StatementLineStatus,
  StatementStatus,
} from '@accounting/types';
import { useBankAccounts } from '@/lib/api/assets-banking-hooks';
import { titleCase } from '@/lib/format';

export const ACCOUNTS_PATH = '/banking/accounts';
export const TRANSACTIONS_PATH = '/banking/transactions';
export const RECONCILIATION_PATH = '/banking/reconciliation';

const TX_VARIANT: Record<BankTransactionStatus, 'secondary' | 'success' | 'destructive'> = {
  DRAFT: 'secondary',
  POSTED: 'success',
  VOID: 'destructive',
};
export function TxStatusBadge({ status }: { status: BankTransactionStatus }) {
  return <Badge variant={TX_VARIANT[status]}>{titleCase(status)}</Badge>;
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
  return <Badge variant={LINE_VARIANT[status]}>{titleCase(status)}</Badge>;
}

export function StatementStatusBadge({ status }: { status: StatementStatus }) {
  return (
    <Badge variant={status === 'RECONCILED' ? 'success' : 'warning'}>{titleCase(status)}</Badge>
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
