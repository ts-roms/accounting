'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Banknote, Download, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { PAYMENT_RUN_SELECTION_MODES } from '@accounting/types';
import { P, PAYMENT_RUN_STATUSES } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreatePaymentRun,
  useDownloadRemittance,
  usePaymentRun,
  usePaymentRunAction,
  usePaymentRuns,
  useUpdatePaymentRunLines,
  useVendorGroups,
} from '@/lib/api/payables-hooks';
import type { PaymentRun, PaymentRunDetail, PaymentRunLine } from '@/lib/api/payables-types';
import { titleCase } from '@/lib/format';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { DescriptionList, Field, ReasonDialog, StatusBadge } from '@/components/receivables/shared';

// ------------------------------------------------------------------- list

export function PaymentRunsPage() {
  const router = useRouter();
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [create, setCreate] = React.useState(false);
  const runs = usePaymentRuns({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as PaymentRun['status']),
  });
  const columns = React.useMemo<ColumnDef<PaymentRun>[]>(
    () => [
      {
        id: 'number',
        header: 'Run',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-mono text-sm">{row.original.documentNumber}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.description ?? titleCase(row.original.selectionMode)}
            </div>
          </div>
        ),
      },
      {
        id: 'paymentDate',
        header: 'Pay on',
        enableSorting: false,
        cell: ({ row }) => row.original.paymentDate,
      },
      {
        id: 'bank',
        header: 'From',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.cashAccountCode} {row.original.cashAccountName}
          </span>
        ),
      },
      {
        id: 'vendors',
        header: 'Vendors',
        enableSorting: false,
        cell: ({ row }) => `${row.original.vendorCount} / ${row.original.lineCount} bills`,
      },
      {
        id: 'discount',
        header: () => <div className="text-right">Discount</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.totalDiscount} className="text-success" />,
      },
      {
        id: 'total',
        header: () => <div className="text-right">Cash</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.totalAmount} />,
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
        title="Payment Runs"
        description="Propose which bills to pay by due date and discount window, approve the selection, then execute: one posted payment per vendor."
        actions={
          <Can permissions={[P['payment-run.create']]}>
            <Button size="sm" onClick={() => setCreate(true)}>
              <Plus /> Propose run
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={runs.data}
        isLoading={runs.isLoading}
        isFetching={runs.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/payables/payment-runs/${r.id}`)}
        emptyState={
          <EmptyState
            icon={Banknote}
            title="No payment runs"
            description="Propose a run to select the open bills to pay."
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
              {PAYMENT_RUN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <ProposeRunDialog
        open={create}
        onOpenChange={setCreate}
        onCreated={(id) => router.push(`/payables/payment-runs/${id}`)}
      />
    </>
  );
}

function ProposeRunDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreatePaymentRun();
  const groups = useVendorGroups();
  const [cashAccountId, setCashAccountId] = React.useState<string | null>(null);
  const [paymentDate, setPaymentDate] = React.useState(today());
  const [payThroughDate, setPayThroughDate] = React.useState('');
  const [mode, setMode] =
    React.useState<(typeof PAYMENT_RUN_SELECTION_MODES)[number]>('DUE_OR_DISCOUNT');
  const [groupId, setGroupId] = React.useState('ALL');
  const [maximum, setMaximum] = React.useState('');
  const [description, setDescription] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Propose a payment run</DialogTitle>
          <DialogDescription>
            Open, posted bills without a hold are selected under the AP policy; you can still adjust
            lines before submitting.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Pay from (cash / bank account)">
              <AccountCombobox
                value={cashAccountId}
                onChange={(id) => setCashAccountId(id)}
                types={['ASSET']}
              />
            </Field>
          </div>
          <Field label="Payment date">
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </Field>
          <Field label="Pay bills due through" hint="Defaults to the payment date">
            <Input
              type="date"
              value={payThroughDate}
              onChange={(e) => setPayThroughDate(e.target.value)}
            />
          </Field>
          <Field label="Selection">
            <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DUE">Due bills only</SelectItem>
                <SelectItem value="DUE_OR_DISCOUNT">Due bills + open discounts</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Vendor group">
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All vendors</SelectItem>
                {(groups.data ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Maximum cash" hint="Oldest-due bills first until reached">
            <Input
              inputMode="decimal"
              value={maximum}
              onChange={(e) => setMaximum(e.target.value)}
              placeholder="No limit"
            />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!cashAccountId || create.isPending}
            onClick={async () => {
              try {
                const run = await create.mutateAsync({
                  cashAccountId: cashAccountId!,
                  paymentDate,
                  payThroughDate: payThroughDate || undefined,
                  selectionMode: mode,
                  method: 'BANK_TRANSFER',
                  vendorGroupId: groupId === 'ALL' ? undefined : groupId,
                  maximumAmount: maximum || undefined,
                  description: description || undefined,
                });
                toast.success(
                  `${run.documentNumber} proposed: ${run.lineCount} bill(s), ${run.vendorCount} vendor(s).`,
                );
                onOpenChange(false);
                onCreated(run.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Propose
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------- detail

export function PaymentRunDetailPage({ id }: { id: string }) {
  const run = usePaymentRun(id);
  const action = usePaymentRunAction();
  const updateLines = useUpdatePaymentRunLines();
  const download = useDownloadRemittance();
  const [cancel, setCancel] = React.useState(false);
  const [approve, setApprove] = React.useState(false);
  const r = run.data;
  const editable = r?.status === 'DRAFT';

  const act = async (
    kind: 'submit' | 'approve' | 'execute' | 'cancel',
    extra?: { note?: string; reason?: string },
  ) => {
    try {
      const out = await action.mutateAsync({ id, action: kind, ...extra });
      toast.success(
        `${out.documentNumber} ${kind === 'execute' ? titleCase(out.status).toLowerCase() : kind + 'ted'}.`,
      );
      setCancel(false);
      setApprove(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const toggle = async (line: PaymentRunLine, excluded: boolean) => {
    try {
      await updateLines.mutateAsync({ id, lines: [{ billId: line.billId, excluded }] });
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const dropDiscount = async (line: PaymentRunLine) => {
    try {
      await updateLines.mutateAsync({ id, lines: [{ billId: line.billId, takeDiscount: false }] });
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  if (!r) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader
        title={r.documentNumber}
        description={
          <span className="flex items-center gap-2">
            <StatusBadge status={r.status} /> {r.description ?? titleCase(r.selectionMode)} - pay on{' '}
            {r.paymentDate} from {r.cashAccountCode} {r.cashAccountName}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/payables/payment-runs">
                <ArrowLeft /> Runs
              </Link>
            </Button>
            {r.status === 'DRAFT' ? (
              <Can permissions={[P['payment-run.create']]}>
                <Button
                  size="sm"
                  disabled={action.isPending || r.lineCount === 0}
                  onClick={() => act('submit')}
                >
                  Submit for approval
                </Button>
              </Can>
            ) : null}
            {r.status === 'DRAFT' || r.status === 'SUBMITTED' ? (
              <Can permissions={[P['payment-run.approve']]}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action.isPending}
                  onClick={() => setApprove(true)}
                >
                  Approve
                </Button>
              </Can>
            ) : null}
            {r.status === 'APPROVED' ? (
              <Can permissions={[P['payment-run.execute']]}>
                <Button size="sm" disabled={action.isPending} onClick={() => act('execute')}>
                  Execute payments
                </Button>
              </Can>
            ) : null}
            {r.status === 'COMPLETED' || r.status === 'PARTIALLY_COMPLETED' ? (
              <Can permissions={[P['payment-run.execute']]}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={download.isPending}
                  onClick={async () => {
                    try {
                      const f = await download.mutateAsync({ id, format: 'CSV' });
                      toast.success(`${f} downloaded.`);
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  <Download /> Remittance CSV
                </Button>
              </Can>
            ) : null}
            {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(r.status) ? (
              <Can permissions={[P['payment-run.create']]}>
                <Button size="sm" variant="ghost" onClick={() => setCancel(true)}>
                  Cancel run
                </Button>
              </Can>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Bills in this run</CardTitle>
            <CardDescription>
              {editable
                ? 'Untick a bill to exclude it, or drop a discount to pay the full balance. Held bills cannot be added.'
                : 'The selection is locked once submitted.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {editable ? <TableHead className="w-8" /> : null}
                  <TableHead>Vendor / bill</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">Pay</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.lines.map((l) => (
                  <TableRow
                    key={l.id}
                    className={l.status === 'EXCLUDED' ? 'opacity-60' : undefined}
                  >
                    {editable ? (
                      <TableCell>
                        <Checkbox
                          checked={l.status === 'SELECTED'}
                          disabled={
                            updateLines.isPending ||
                            l.note === 'ON_HOLD' ||
                            l.note === 'VENDOR_ON_HOLD'
                          }
                          onCheckedChange={(v) => void toggle(l, v !== true)}
                          aria-label={`Include ${l.billNumber}`}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <div className="font-medium">{l.vendorName}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        <Link href={`/purchasing/bills/${l.billId}`} className="hover:underline">
                          {l.billNumber}
                        </Link>
                        {l.vendorInvoiceNumber ? ` - ${l.vendorInvoiceNumber}` : ''}
                        {l.paymentNumber ? ` - paid by ${l.paymentNumber}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {l.dueDate}
                      {l.discountDate ? (
                        <div className="text-muted-foreground">disc. until {l.discountDate}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Amount value={l.openAmount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={l.discountTaken} className="text-success" />
                      {editable && l.status === 'SELECTED' && Number(l.discountTaken) > 0 ? (
                        <button
                          type="button"
                          className="block text-xs text-muted-foreground hover:underline"
                          onClick={() => void dropDiscount(l)}
                        >
                          pay in full
                        </button>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Amount value={l.amount} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={l.status} />
                      {l.skipReason ? (
                        <div className="text-xs text-muted-foreground">
                          {titleCase(l.skipReason)}
                        </div>
                      ) : null}
                      {l.failureReason ? (
                        <div className="text-xs text-destructive">{l.failureReason}</div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Totals</CardTitle>
            </CardHeader>
            <CardContent>
              <DescriptionList
                items={[
                  [
                    'Cash to pay',
                    <Amount key="c" value={r.totalAmount} className="inline font-semibold" />,
                  ],
                  [
                    'Discounts taken',
                    <Amount key="d" value={r.totalDiscount} className="inline text-success" />,
                  ],
                  ['Bills', r.lineCount],
                  ['Vendors', r.vendorCount],
                  ['Pay through', r.payThroughDate],
                  ['Method', titleCase(r.method)],
                  ['Proposed by', r.createdByName ?? '-'],
                  ['Approved by', r.approvedByName ?? '-'],
                  ['Executed', r.executedAt ? r.executedAt.slice(0, 10) : '-'],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per vendor</CardTitle>
              <CardDescription>One payment per vendor on execution.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  {r.vendorTotals.map((v) => (
                    <TableRow key={v.vendorId}>
                      <TableCell>
                        <div className="text-sm">{v.vendorName}</div>
                        <div className="text-xs text-muted-foreground">{v.bills} bill(s)</div>
                      </TableCell>
                      <TableCell>
                        <Amount value={v.amount} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
      <ReasonDialog
        open={cancel}
        onOpenChange={setCancel}
        title={`Cancel ${r.documentNumber}`}
        destructive
        confirmLabel="Cancel run"
        loading={action.isPending}
        onConfirm={(reason) => act('cancel', { reason })}
      />
      <ApproveDialog
        open={approve}
        onOpenChange={setApprove}
        run={r}
        loading={action.isPending}
        onConfirm={(note) => act('approve', { note })}
      />
    </>
  );
}

function ApproveDialog({
  open,
  onOpenChange,
  run,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: PaymentRunDetail;
  loading?: boolean;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {run.documentNumber}</DialogTitle>
          <DialogDescription>
            Locks the selection: {run.lineCount} bill(s) for {run.vendorCount} vendor(s),{' '}
            <Amount value={run.totalAmount} className="inline" /> cash with{' '}
            <Amount value={run.totalDiscount} className="inline" /> in discounts. Bills held after
            the proposal are dropped.
          </DialogDescription>
        </DialogHeader>
        <Field label="Note (optional)">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button disabled={loading} onClick={() => onConfirm(note.trim())}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
