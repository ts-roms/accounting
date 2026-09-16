'use client';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatMoney } from '@accounting/money';
import { HEADERS } from '@accounting/config';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { api } from '@/lib/api/client';
import { useSettleIntercompany } from '@/lib/api/consolidation-hooks';
import type { BankAccount, IntercompanyTransaction } from '@/lib/api/types';
import { OperationDialog, POSTING_STEPS } from '@/components/accounting/operation-dialog';
import { today } from '@/components/accounting/primitives';
import { Field } from '@/components/receivables/shared';

/** Bank accounts of a specific company (the picker spans two companies, so the header is explicit). */
function useCompanyBankAccounts(companyId: string | null) {
  return useQuery({
    queryKey: ['banking', companyId, 'accounts-for-settlement'],
    queryFn: () =>
      api.get<BankAccount[]>('/bank-accounts', { headers: { [HEADERS.COMPANY_ID]: companyId! } }),
    enabled: Boolean(companyId),
  });
}

/** Settle a posted intercompany charge in cash: both bank legs post in one transaction. */
export function SettleIntercompanyDialog({
  transaction,
  open,
  onOpenChange,
  onSettled,
}: {
  transaction: IntercompanyTransaction;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSettled: (t: IntercompanyTransaction) => void;
}) {
  const settle = useSettleIntercompany();
  const fromBanks = useCompanyBankAccounts(transaction.fromCompanyId);
  const toBanks = useCompanyBankAccounts(transaction.toCompanyId);
  const [date, setDate] = React.useState(today());
  const [fromBank, setFromBank] = React.useState('');
  const [toBank, setToBank] = React.useState('');
  const [reference, setReference] = React.useState('');
  return (
    <OperationDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Settle ${transaction.documentNumber} in cash`}
      description={`${transaction.fromCompanyCode} pays ${formatMoney(transaction.amount, transaction.currency)} from its bank (Dr intercompany payable / Cr bank); ${transaction.toCompanyCode} banks it (Dr bank / Cr intercompany receivable). Both legs post together or not at all.`}
      confirmLabel="Settle"
      loadingLabel="Posting both legs..."
      resultLabel="Settled"
      steps={POSTING_STEPS}
      run={async () => {
        const t = await settle.mutateAsync({
          id: transaction.id,
          settlementDate: date,
          fromBankAccountId: fromBank,
          toBankAccountId: toBank,
          reference: reference || undefined,
        });
        onSettled(t);
        return t;
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Paid from (${transaction.fromCompanyCode})`}>
          <Select value={fromBank} onValueChange={setFromBank}>
            <SelectTrigger aria-label="Paying bank account">
              <SelectValue placeholder="Bank account" />
            </SelectTrigger>
            <SelectContent>
              {(fromBanks.data ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.code} {b.name} - {formatMoney(b.ledgerBalance, b.currency)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={`Received into (${transaction.toCompanyCode})`}>
          <Select value={toBank} onValueChange={setToBank}>
            <SelectTrigger aria-label="Receiving bank account">
              <SelectValue placeholder="Bank account" />
            </SelectTrigger>
            <SelectContent>
              {(toBanks.data ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.code} {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Settlement date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Bank reference">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
    </OperationDialog>
  );
}
