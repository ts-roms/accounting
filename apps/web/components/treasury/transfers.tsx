'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, ArrowLeftRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@accounting/money';
import type { BankTransferPurpose } from '@accounting/types';
import { BANK_TRANSFER_PURPOSES, BANK_TRANSFER_STATUSES, P } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StepTimeline,
  Textarea,
  type TimelineStep,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useBankAccounts } from '@/lib/api/assets-banking-hooks';
import {
  useBankTransfer,
  useBankTransferAction,
  useBankTransfers,
  useCreateBankTransfer,
  useTreasurySettings,
} from '@/lib/api/treasury-hooks';
import type { BankTransfer } from '@/lib/api/treasury-types';
import { formatDateTime, titleCase } from '@/lib/format';
import {
  APPROVAL_STEPS,
  OperationDialog,
  POSTING_STEPS,
} from '@/components/accounting/operation-dialog';
import { Amount, today } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { DescriptionList, Field, ReasonDialog, StatusBadge } from '@/components/receivables/shared';

// ------------------------------------------------------------------- list

export function BankTransfersPage() {
  const router = useAppRouter();
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [create, setCreate] = React.useState(false);
  const transfers = useBankTransfers({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as BankTransfer['status']),
  });
  const columns = React.useMemo<ColumnDef<BankTransfer>[]>(
    () => [
      {
        id: 'number',
        header: 'Transfer',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-mono text-sm">{row.original.documentNumber}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.reference ?? titleCase(row.original.purpose)}
            </div>
          </div>
        ),
      },
      {
        id: 'date',
        header: 'Date',
        enableSorting: false,
        cell: ({ row }) => row.original.transferDate,
      },
      {
        id: 'route',
        header: 'From / to',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.fromCode}{' '}
            <ArrowLeftRight className="inline size-3 text-muted-foreground" /> {row.original.toCode}
          </span>
        ),
      },
      {
        id: 'amount',
        header: () => <div className="text-right">Amount</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <Amount value={row.original.amount} currency={row.original.fromCurrency} />
            {row.original.toCurrency !== row.original.fromCurrency ? (
              <div className="text-right text-xs text-muted-foreground">
                {formatMoney(row.original.receivedAmount, row.original.toCurrency)}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'settle',
        header: 'Settles',
        enableSorting: false,
        cell: ({ row }) => row.original.settlementDate ?? row.original.expectedSettlementDate,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Bank Transfers"
        description="Move cash between your own bank accounts. Sending posts to cash in transit; settlement clears it into the destination, with any FX difference realized."
        actions={
          <Can permissions={[P['bank-transfer.create']]}>
            <Button size="sm" onClick={() => setCreate(true)}>
              <Plus /> New transfer
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={transfers.data}
        isLoading={transfers.isLoading}
        isFetching={transfers.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/treasury/transfers/${r.id}`)}
        emptyState={
          <EmptyState
            icon={ArrowLeftRight}
            title="No transfers"
            description="Fund a reserve account or sweep surplus cash with a transfer."
          />
        }
        toolbar={
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              table.resetPage();
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {BANK_TRANSFER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <NewTransferDialog
        open={create}
        onOpenChange={setCreate}
        onCreated={(id) => router.push(`/treasury/transfers/${id}`)}
      />
    </>
  );
}

function NewTransferDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateBankTransfer();
  const banks = useBankAccounts();
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [transferDate, setDate] = React.useState(today());
  const [expected, setExpected] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [received, setReceived] = React.useState('');
  const [fee, setFee] = React.useState('');
  const [purpose, setPurpose] = React.useState<BankTransferPurpose>('FUNDING');
  const [reference, setReference] = React.useState('');
  const [memo, setMemo] = React.useState('');
  const fromAcct = banks.data?.find((b) => b.id === from);
  const toAcct = banks.data?.find((b) => b.id === to);
  const cross = fromAcct && toAcct && fromAcct.currency !== toAcct.currency;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New bank transfer</DialogTitle>
          <DialogDescription>
            Drafts have no ledger effect. Transfers above the approval threshold need a second
            approver before they can be sent.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From account">
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger aria-label="From account">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                {(banks.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.code} - {b.currency} {formatMoney(b.ledgerBalance, b.currency)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="To account">
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger aria-label="To account">
                <SelectValue placeholder="Destination" />
              </SelectTrigger>
              <SelectContent>
                {(banks.data ?? [])
                  .filter((b) => b.id !== from)
                  .map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.code} - {b.currency}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={`Amount${fromAcct ? ` (${fromAcct.currency})` : ''}`}>
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount"
            />
          </Field>
          <Field label="Bank fee" hint="Deducted from the source; posted to bank charges">
            <Input
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="0"
            />
          </Field>
          {cross ? (
            <div className="sm:col-span-2">
              <Field
                label={`Amount received (${toAcct!.currency})`}
                hint="Leave blank to use the rate table; the actual credited amount can be entered at settlement."
              >
                <Input
                  inputMode="decimal"
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
          <Field label="Transfer date">
            <Input type="date" value={transferDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Expected settlement" hint="Defaults to the transfer date">
            <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </Field>
          <Field label="Purpose">
            <Select value={purpose} onValueChange={(v) => setPurpose(v as BankTransferPurpose)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BANK_TRANSFER_PURPOSES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {titleCase(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Memo">
              <Textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!from || !to || !amount || create.isPending}
            onClick={async () => {
              try {
                const t = await create.mutateAsync({
                  fromBankAccountId: from,
                  toBankAccountId: to,
                  transferDate,
                  expectedSettlementDate: expected || undefined,
                  amount,
                  receivedAmount: cross && received ? received : undefined,
                  feeAmount: fee || undefined,
                  purpose,
                  reference: reference || undefined,
                  memo: memo || undefined,
                });
                toast.success(`${t.documentNumber} drafted.`);
                onOpenChange(false);
                onCreated(t.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------- detail

function timeline(t: BankTransfer): TimelineStep[] {
  const meta = (when: string | null) => (when ? formatDateTime(when) : undefined);
  const cancelled = t.status === 'CANCELLED';
  const order = ['DRAFT', 'APPROVED', 'SENT', 'SETTLED'];
  const idx = order.indexOf(t.status);
  const state = (i: number): TimelineStep['state'] =>
    cancelled
      ? i === 0
        ? 'complete'
        : 'skipped'
      : i < idx
        ? 'complete'
        : i === idx
          ? i === 3
            ? 'complete'
            : 'current'
          : 'upcoming';
  const steps: TimelineStep[] = [
    { key: 'draft', label: 'Drafted', state: 'complete', meta: meta(t.createdAt) },
    {
      key: 'approved',
      label: 'Approved',
      state: t.approvedAt ? 'complete' : state(1),
      meta: meta(t.approvedAt),
    },
    {
      key: 'sent',
      label: 'Sent (cash in transit)',
      state: state(2),
      meta: meta(t.sentAt),
      description: t.outJournalNumber ?? undefined,
    },
    {
      key: 'settled',
      label: 'Settled',
      state: state(3),
      meta: meta(t.settledAt),
      description: t.inJournalNumber ?? undefined,
    },
  ];
  if (cancelled)
    steps.push({
      key: 'cancelled',
      label: 'Cancelled',
      state: 'failed',
      description: t.cancelReason ?? undefined,
    });
  return steps;
}

export function BankTransferDetailPage({ id }: { id: string }) {
  const transfer = useBankTransfer(id);
  const settings = useTreasurySettings();
  const action = useBankTransferAction();
  const [pending, setPending] = React.useState<'approve' | 'send' | 'settle' | 'cancel' | null>(
    null,
  );
  const [settlementDate, setSettlementDate] = React.useState(today());
  const [received, setReceived] = React.useState('');
  const [bankReference, setBankReference] = React.useState('');
  const t = transfer.data;
  if (!t) return <Skeleton className="h-96" />;
  const threshold = settings.data?.transferApprovalThreshold ?? null;
  const needsApproval = threshold === null || Number(t.baseAmount) > Number(threshold);
  const run = (kind: 'approve' | 'send' | 'settle', body?: Record<string, unknown>) =>
    action.mutateAsync({ id, action: kind, body });

  return (
    <>
      <PageHeader
        title={t.documentNumber}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} /> {titleCase(t.purpose)} - {t.fromCode} to {t.toCode} on{' '}
            {t.transferDate}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/treasury/transfers">
                <ArrowLeft /> Transfers
              </Link>
            </Button>
            {t.status === 'DRAFT' ? (
              <Can permissions={[P['bank-transfer.create']]}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action.isPending}
                  onClick={async () => {
                    try {
                      await action.mutateAsync({ id, action: 'submit' });
                      toast.success('Submitted for approval.');
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  Submit for approval
                </Button>
              </Can>
            ) : null}
            {t.status === 'DRAFT' ? (
              <Can permissions={[P['bank-transfer.approve']]}>
                <Button size="sm" variant="outline" onClick={() => setPending('approve')}>
                  Approve
                </Button>
              </Can>
            ) : null}
            {t.status === 'APPROVED' || (t.status === 'DRAFT' && !needsApproval) ? (
              <Can permissions={[P['bank-transfer.post']]}>
                <Button size="sm" onClick={() => setPending('send')}>
                  Send
                </Button>
              </Can>
            ) : null}
            {t.status === 'SENT' ? (
              <Can permissions={[P['bank-transfer.post']]}>
                <Button size="sm" onClick={() => setPending('settle')}>
                  Settle
                </Button>
              </Can>
            ) : null}
            {t.status === 'DRAFT' || t.status === 'APPROVED' ? (
              <Can permissions={[P['bank-transfer.create']]}>
                <Button size="sm" variant="ghost" onClick={() => setPending('cancel')}>
                  Cancel
                </Button>
              </Can>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Transfer</CardTitle>
            <CardDescription>
              {needsApproval
                ? 'Above the approval threshold: a second person must approve before it can be sent.'
                : 'Under the approval threshold: may be sent from draft.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                ['From', `${t.fromCode} ${t.fromName}`],
                ['To', `${t.toCode} ${t.toName}`],
                ['Amount sent', formatMoney(t.amount, t.fromCurrency)],
                ['Amount received', formatMoney(t.receivedAmount, t.toCurrency)],
                ['Bank fee', formatMoney(t.feeAmount, t.fromCurrency)],
                ['Base amount', formatMoney(t.baseAmount)],
                ['Exchange rate', t.exchangeRate],
                ['FX difference', t.status === 'SETTLED' ? formatMoney(t.fxDifference) : '-'],
                ['Expected settlement', t.expectedSettlementDate],
                ['Settled on', t.settlementDate ?? '-'],
                ['Reference', t.reference ?? '-'],
                ['Bank reference', t.bankReference ?? '-'],
                ['Memo', t.memo ?? '-'],
                [
                  'Journals',
                  <span key="j" className="font-mono text-xs">
                    {t.outJournalEntryId ? (
                      <Link
                        href={`/accounting/journal-entries/${t.outJournalEntryId}`}
                        className="hover:underline"
                      >
                        {t.outJournalNumber}
                      </Link>
                    ) : (
                      '-'
                    )}
                    {t.inJournalEntryId ? (
                      <>
                        {' / '}
                        <Link
                          href={`/accounting/journal-entries/${t.inJournalEntryId}`}
                          className="hover:underline"
                        >
                          {t.inJournalNumber}
                        </Link>
                      </>
                    ) : null}
                  </span>,
                ],
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent>
            <StepTimeline steps={timeline(t)} />
          </CardContent>
        </Card>
      </div>

      <OperationDialog
        open={pending === 'approve'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Approve ${t.documentNumber}`}
        description="Approval is delegable and segregated from the person who drafted the transfer. No ledger effect yet."
        confirmLabel="Approve"
        loadingLabel="Approving..."
        resultLabel="Approved"
        steps={APPROVAL_STEPS}
        run={() => run('approve')}
      />
      <OperationDialog
        open={pending === 'send'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Send ${t.documentNumber}`}
        description={`Debits cash in transit and credits ${t.fromCode} for ${formatMoney(t.amount, t.fromCurrency)}${Number(t.feeAmount) ? ` plus a ${formatMoney(t.feeAmount, t.fromCurrency)} bank fee` : ''}. The destination is credited only at settlement.`}
        confirmLabel="Send"
        loadingLabel="Posting..."
        resultLabel="Sent"
        steps={POSTING_STEPS}
        run={() => run('send')}
      />
      <OperationDialog
        open={pending === 'settle'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Settle ${t.documentNumber}`}
        description={`Debits ${t.toCode} and clears cash in transit. Any difference between the amount credited and the amount sent is realized FX.`}
        confirmLabel="Settle"
        loadingLabel="Posting..."
        resultLabel="Settled"
        steps={POSTING_STEPS}
        run={() =>
          run('settle', {
            settlementDate,
            receivedAmount: received || undefined,
            bankReference: bankReference || undefined,
          })
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Settlement date">
            <Input
              type="date"
              value={settlementDate}
              onChange={(e) => setSettlementDate(e.target.value)}
            />
          </Field>
          <Field
            label={`Amount credited (${t.toCurrency})`}
            hint={`Defaults to ${formatMoney(t.receivedAmount, t.toCurrency)}`}
          >
            <Input
              inputMode="decimal"
              value={received}
              onChange={(e) => setReceived(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Bank reference">
              <Input value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
            </Field>
          </div>
        </div>
      </OperationDialog>
      <ReasonDialog
        open={pending === 'cancel'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Cancel ${t.documentNumber}`}
        description="Cancelling a draft or approved transfer has no ledger effect."
        confirmLabel="Cancel transfer"
        destructive
        loading={action.isPending}
        onConfirm={async (reason) => {
          try {
            await action.mutateAsync({ id, action: 'cancel', body: { reason } });
            toast.success('Transfer cancelled.');
            setPending(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
