'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  BANK_TRANSACTION_STATUSES,
  BANK_TRANSACTION_TYPES,
  P,
  type BankTransactionStatus,
} from '@accounting/types';
import {
  createBankTransactionSchema,
  type CreateBankTransactionInput,
} from '@accounting/validation';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useBankTransaction,
  useBankTransactions,
  useCreateBankTransaction,
  useDeleteBankTransaction,
  usePostBankTransaction,
  useUpdateBankTransaction,
  useVoidBankTransaction,
} from '@/lib/api/assets-banking-hooks';
import type { BankTransaction } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { Field } from '@/components/fixed-assets/shared';
import { BankAccountSelect, MONEY_IN, TxStatusBadge } from './shared';

type TxFormInput = z.input<typeof createBankTransactionSchema>;

function signed(t: BankTransaction): string {
  return MONEY_IN[t.transactionType] ? t.amount : `-${t.amount}`;
}

export function BankTransactionsPage() {
  const params = useSearchParams();
  const table = useTableState({ sortBy: 'transactionDate', sortDir: 'desc' });
  const [bankAccountId, setBankAccountId] = React.useState<string | null>(
    params.get('bankAccountId'),
  );
  const [status, setStatus] = React.useState('ALL');
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const txs = useBankTransactions({
    ...table.query,
    bankAccountId: bankAccountId ?? undefined,
    status: status === 'ALL' ? undefined : (status as BankTransactionStatus),
  });
  const columns = React.useMemo<ColumnDef<BankTransaction>[]>(
    () => [
      {
        accessorKey: 'transactionDate',
        header: 'Date',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.transactionDate}</span>
        ),
      },
      {
        accessorKey: 'documentNumber',
        header: 'Number',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.documentNumber}</span>,
      },
      {
        id: 'type',
        header: 'Type',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.transactionType),
      },
      {
        id: 'account',
        header: 'Bank account',
        enableSorting: false,
        cell: ({ row }) => (
          <span>
            <span className="mr-1 font-mono text-xs text-muted-foreground">
              {row.original.bankAccountCode}
            </span>
            {row.original.toBankAccountCode ? (
              <span className="text-xs text-muted-foreground">
                → {row.original.toBankAccountCode}
              </span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'counterparty',
        header: 'Other side',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.counterpartyCode ? (
            <span className="text-xs">
              <span className="mr-1 font-mono">{row.original.counterpartyCode}</span>
              {row.original.counterpartyName}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Transfer</span>
          ),
      },
      {
        id: 'reference',
        header: 'Reference / memo',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.reference ? (
              <span className="font-mono">{row.original.reference}</span>
            ) : null}
            {row.original.memo ? (
              <span className="ml-1 text-muted-foreground">{row.original.memo}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'amount',
        header: () => <div className="text-right">Amount</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={signed(row.original)} currency={row.original.currency} />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <TxStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Bank transactions"
        description="Deposits, withdrawals, fees, interest and transfers recorded directly against a bank account. Customer receipts and vendor payments live in receivables / payables."
        actions={
          <Can permissions={[P['bank-transaction.create']]}>
            <Button onClick={() => setCreating(true)} data-testid="new-transaction">
              <Plus /> New transaction
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={txs.data}
        isLoading={txs.isLoading}
        isFetching={txs.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(t) => t.id}
        onRowClick={(t) => setSelected(t.id)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Number, reference, memo"
                className="w-64 pl-8"
              />
            </div>
            <BankAccountSelect
              value={bankAccountId}
              onChange={(id) => {
                setBankAccountId(id);
                table.resetPage();
              }}
              allowAll="All bank accounts"
              className="w-56"
            />
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {BANK_TRANSACTION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <TransactionDialog
        open={creating}
        onOpenChange={setCreating}
        defaults={{ bankAccountId: bankAccountId ?? undefined }}
        onSaved={(t) => setSelected(t.id)}
      />
      <TransactionDetailDialog id={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

/** Create / edit a draft bank transaction. `defaults` pre-fills from a statement line. */
export function TransactionDialog({
  open,
  transaction,
  defaults: seed,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  transaction?: BankTransaction;
  defaults?: Partial<TxFormInput>;
  onOpenChange: (open: boolean) => void;
  onSaved?: (t: BankTransaction) => void;
}) {
  const create = useCreateBankTransaction();
  const update = useUpdateBankTransaction();
  const defaults = React.useCallback(
    (): TxFormInput => ({
      bankAccountId: transaction?.bankAccountId ?? seed?.bankAccountId ?? '',
      transactionType: transaction?.transactionType ?? seed?.transactionType ?? 'DEPOSIT',
      transactionDate: transaction?.transactionDate ?? seed?.transactionDate ?? today(),
      amount: transaction?.amount ?? seed?.amount ?? '',
      counterpartyAccountId: transaction?.counterpartyAccountId ?? undefined,
      toBankAccountId: transaction?.toBankAccountId ?? undefined,
      reference: transaction?.reference ?? seed?.reference ?? undefined,
      memo: transaction?.memo ?? seed?.memo ?? undefined,
      statementLineId: seed?.statementLineId,
    }),
    [transaction, seed],
  );
  const form = useForm<TxFormInput, unknown, CreateBankTransactionInput>({
    resolver: zodResolver(createBankTransactionSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed object identity changes on every render; reset only when opened
  }, [open, form, transaction]);
  const type = form.watch('transactionType');
  const bankAccountId = form.watch('bankAccountId');
  const submit = form.handleSubmit(async (values) => {
    try {
      const saved = transaction
        ? await update.mutateAsync({ id: transaction.id, ...values })
        : await create.mutateAsync(values);
      toast.success(`${saved.documentNumber} ${transaction ? 'updated' : 'drafted'}.`);
      onOpenChange(false);
      onSaved?.(saved);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {transaction ? `Edit ${transaction.documentNumber}` : 'New bank transaction'}
          </DialogTitle>
          <DialogDescription>
            {seed?.statementLineId
              ? 'Recording a statement line: posting this transaction matches the line automatically.'
              : 'Saved as a draft. Posting writes the journal: the bank GL account against the other side.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="bankAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bank account</FormLabel>
                    <BankAccountSelect
                      value={field.value || null}
                      onChange={(id) => field.onChange(id ?? '')}
                      disabled={Boolean(seed?.statementLineId)}
                      testId="tx-bank-account"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="transactionType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="tx-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {BANK_TRANSACTION_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {titleCase(t)} {MONEY_IN[t] ? '(in)' : '(out)'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="transactionDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        className="text-right tabular"
                        {...field}
                        data-testid="tx-amount"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {type === 'TRANSFER' ? (
              <FormField
                control={form.control}
                name="toBankAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>To bank account</FormLabel>
                    <BankAccountSelect
                      value={field.value ?? null}
                      onChange={(id) => field.onChange(id ?? undefined)}
                      excludeId={bankAccountId}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="counterpartyAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {MONEY_IN[type]
                        ? 'Credit account (income / clearing)'
                        : 'Debit account (expense / clearing)'}
                    </FormLabel>
                    <AccountCombobox
                      value={field.value ?? null}
                      onChange={(id) => field.onChange(id)}
                      types={
                        MONEY_IN[type]
                          ? ['REVENUE', 'LIABILITY', 'ASSET', 'EQUITY']
                          : ['EXPENSE', 'ASSET', 'LIABILITY']
                      }
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
              <FormField
                control={form.control}
                name="reference"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reference</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} className="font-mono" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="memo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Memo</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || update.isPending}
                data-testid="tx-save"
              >
                {transaction ? 'Save' : 'Save draft'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function TransactionDetailDialog({
  id,
  onOpenChange,
}: {
  id: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { hasPermission } = useSession();
  const tx = useBankTransaction(id);
  const post = usePostBankTransaction();
  const remove = useDeleteBankTransaction();
  const voidTx = useVoidBankTransaction();
  const [editing, setEditing] = React.useState(false);
  const [voiding, setVoiding] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const t = tx.data;
  const canCreate = hasPermission(P['bank-transaction.create']);
  const canPost = hasPermission(P['bank-transaction.post']);
  return (
    <>
      <Dialog open={Boolean(id) && !editing} onOpenChange={onOpenChange}>
        <DialogContent size="sm">
          {!t ? (
            <Skeleton className="h-48" />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="font-mono">{t.documentNumber}</span>
                  <TxStatusBadge status={t.status} />
                </DialogTitle>
                <DialogDescription>
                  {titleCase(t.transactionType)} on {t.transactionDate}
                </DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-sm">
                <Field
                  label="Amount"
                  value={
                    <Amount
                      value={signed(t)}
                      currency={t.currency}
                      className="text-left font-semibold"
                    />
                  }
                />
                <Field label="Bank account" value={`${t.bankAccountCode} · ${t.bankAccountName}`} />
                {t.toBankAccountCode ? (
                  <Field label="To" value={t.toBankAccountCode} />
                ) : (
                  <Field
                    label="Other side"
                    value={
                      t.counterpartyCode ? `${t.counterpartyCode} · ${t.counterpartyName}` : '-'
                    }
                  />
                )}
                <Field label="Reference" value={t.reference ?? '-'} />
                <Field label="Memo" value={t.memo ?? '-'} />
                <Field
                  label="Journal"
                  value={
                    t.journalEntryId ? (
                      <Link
                        href={`/accounting/journal-entries/${t.journalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {t.journalNumber}
                      </Link>
                    ) : (
                      '-'
                    )
                  }
                />
                {t.postedAt ? <Field label="Posted" value={formatDateTime(t.postedAt)} /> : null}
                {t.voidReason ? <Field label="Void reason" value={t.voidReason} /> : null}
              </dl>
              {voiding ? (
                <div className="space-y-1">
                  <Label>Reason</Label>
                  <Textarea
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    autoFocus
                  />
                </div>
              ) : null}
              <DialogFooter>
                {canCreate && t.status === 'DRAFT' ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={remove.isPending}
                      onClick={async () => {
                        try {
                          await remove.mutateAsync(t.id);
                          toast.success('Draft deleted.');
                          onOpenChange(false);
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      Delete
                    </Button>
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                  </>
                ) : null}
                {canPost && t.status === 'DRAFT' ? (
                  <Button
                    disabled={post.isPending}
                    data-testid="tx-post"
                    onClick={async () => {
                      try {
                        const posted = await post.mutateAsync(t.id);
                        toast.success(`${posted.documentNumber} posted (${posted.journalNumber}).`);
                      } catch (err) {
                        toast.error(describeError(err));
                      }
                    }}
                  >
                    Post
                  </Button>
                ) : null}
                {canPost && t.status === 'POSTED' ? (
                  voiding ? (
                    <>
                      <Button variant="outline" onClick={() => setVoiding(false)}>
                        Keep
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={reason.trim().length < 3 || voidTx.isPending}
                        onClick={async () => {
                          try {
                            await voidTx.mutateAsync({ id: t.id, reason: reason.trim() });
                            toast.success('Transaction voided; reversal posted.');
                            setVoiding(false);
                            setReason('');
                          } catch (err) {
                            toast.error(describeError(err));
                          }
                        }}
                      >
                        Confirm void
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" onClick={() => setVoiding(true)}>
                      Void
                    </Button>
                  )
                ) : null}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {t ? <TransactionDialog open={editing} transaction={t} onOpenChange={setEditing} /> : null}
    </>
  );
}
