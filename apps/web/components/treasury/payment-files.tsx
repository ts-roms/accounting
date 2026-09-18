'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Download, FileCode2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@accounting/money';
import type { PaymentFileFormat } from '@accounting/types';
import { P, PAYMENT_FILE_FORMATS, PAYMENT_FILE_STATUSES } from '@accounting/types';
import {
  Button,
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
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useBankAccounts } from '@/lib/api/assets-banking-hooks';
import { usePaymentRuns } from '@/lib/api/payables-hooks';
import { usePayments } from '@/lib/api/subledger-hooks';
import {
  useCreatePaymentFile,
  useDownloadPaymentFile,
  usePaymentFile,
  usePaymentFiles,
  useSetPaymentFileStatus,
  useTreasurySettings,
} from '@/lib/api/treasury-hooks';
import type { PaymentFile } from '@/lib/api/treasury-types';
import { AP_CONFIG } from '@/lib/subledger/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { Amount, today } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { DescriptionList, Field, ReasonDialog, StatusBadge } from '@/components/receivables/shared';

const FORMAT_LABEL: Record<PaymentFileFormat, string> = {
  PESONET_CSV: 'PESONet batch (CSV)',
  ISO20022_PAIN001: 'ISO 20022 pain.001 (XML)',
  POSITIVE_PAY_CSV: 'Positive pay (CSV)',
};

export function PaymentFilesPage() {
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [create, setCreate] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const files = usePaymentFiles({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as PaymentFile['status']),
  });
  const columns = React.useMemo<ColumnDef<PaymentFile>[]>(
    () => [
      {
        id: 'number',
        header: 'File',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-mono text-sm">{row.original.documentNumber}</div>
            <div className="truncate text-xs text-muted-foreground">{row.original.filename}</div>
          </div>
        ),
      },
      {
        id: 'format',
        header: 'Format',
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs">{FORMAT_LABEL[row.original.format]}</span>,
      },
      {
        id: 'bank',
        header: 'Bank account',
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs">{row.original.bankAccountCode}</span>,
      },
      {
        id: 'valueDate',
        header: 'Value date',
        enableSorting: false,
        cell: ({ row }) => row.original.valueDate,
      },
      {
        id: 'count',
        header: 'Payments',
        enableSorting: false,
        cell: ({ row }) => row.original.paymentCount,
      },
      {
        id: 'total',
        header: () => <div className="text-right">Total</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.totalAmount} currency={row.original.currency} />
        ),
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
        title="Payment Files"
        description="Bank-ready files for posted vendor payments: PESONet batch credits, ISO 20022 pain.001 and positive-pay cheque registers. Files never post - the payments already did."
        actions={
          <Can permissions={[P['payment-file.manage']]}>
            <Button size="sm" onClick={() => setCreate(true)}>
              <Plus /> Generate file
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={files.data}
        isLoading={files.isLoading}
        isFetching={files.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => setSelected(r.id)}
        emptyState={
          <EmptyState
            icon={FileCode2}
            title="No payment files"
            description="Generate a file from an executed payment run or a set of posted payments."
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
              {PAYMENT_FILE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <GenerateFileDialog open={create} onOpenChange={setCreate} onCreated={setSelected} />
      <PaymentFileDialog id={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

function GenerateFileDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreatePaymentFile();
  const banks = useBankAccounts();
  const settings = useTreasurySettings();
  const runs = usePaymentRuns({ pageSize: 50 });
  const payments = usePayments(AP_CONFIG, {
    pageSize: 100,
    status: 'POSTED',
    paymentType: 'PAYMENT',
  });
  const [bankAccountId, setBank] = React.useState('');
  const [format, setFormat] = React.useState<PaymentFileFormat | ''>('');
  const [mode, setMode] = React.useState<'RUN' | 'PAYMENTS'>('PAYMENTS');
  const [runId, setRunId] = React.useState('');
  const [picked, setPicked] = React.useState<string[]>([]);
  const [valueDate, setValueDate] = React.useState(today());
  const [description, setDescription] = React.useState('');
  const bank = banks.data?.find((b) => b.id === bankAccountId);
  const effectiveFormat = (format ||
    settings.data?.defaultPaymentFileFormat ||
    'PESONET_CSV') as PaymentFileFormat;
  const candidates = (payments.data?.items ?? []).filter(
    (p) => !bank || p.cashAccountId === bank.glAccountId,
  );
  const completedRuns = (runs.data?.items ?? []).filter(
    (r) => r.status === 'COMPLETED' || r.status === 'PARTIALLY_COMPLETED',
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate a payment file</DialogTitle>
          <DialogDescription>
            Only posted vendor payments paid from the chosen bank account and not already in a live
            file are eligible. Beneficiary details come from each vendor&apos;s primary bank
            account.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bank account">
            <Select value={bankAccountId} onValueChange={setBank}>
              <SelectTrigger aria-label="Bank account">
                <SelectValue placeholder="Paying account" />
              </SelectTrigger>
              <SelectContent>
                {(banks.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.code} {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Format">
            <Select
              value={effectiveFormat}
              onValueChange={(v) => setFormat(v as PaymentFileFormat)}
            >
              <SelectTrigger aria-label="Format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_FILE_FORMATS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {FORMAT_LABEL[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Value date">
            <Input type="date" value={valueDate} onChange={(e) => setValueDate(e.target.value)} />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Select by">
            <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PAYMENTS">Individual posted payments</SelectItem>
                <SelectItem value="RUN">Executed payment run</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mode === 'RUN' ? (
            <Field label="Payment run">
              <Select value={runId} onValueChange={setRunId}>
                <SelectTrigger aria-label="Payment run">
                  <SelectValue placeholder="Executed run" />
                </SelectTrigger>
                <SelectContent>
                  {completedRuns.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.documentNumber} - {formatMoney(r.totalAmount, r.currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
        </div>
        {mode === 'PAYMENTS' ? (
          <div className="max-h-64 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-8" />
                  <TableHead>Payment</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Checkbox
                        checked={picked.includes(p.id)}
                        onCheckedChange={(v) =>
                          setPicked((prev) =>
                            v === true ? [...prev, p.id] : prev.filter((x) => x !== p.id),
                          )
                        }
                        aria-label={`Include ${p.documentNumber}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.documentNumber}</TableCell>
                    <TableCell className="text-xs">{p.vendorName ?? '-'}</TableCell>
                    <TableCell className="text-xs">{p.paymentDate}</TableCell>
                    <TableCell>
                      <Amount value={p.amount} currency={p.currency} />
                    </TableCell>
                  </TableRow>
                ))}
                {!candidates.length ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      {bank
                        ? 'No posted payments from this account.'
                        : 'Choose a bank account to list its posted payments.'}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !bankAccountId || create.isPending || (mode === 'RUN' ? !runId : picked.length === 0)
            }
            onClick={async () => {
              try {
                const f = await create.mutateAsync({
                  bankAccountId,
                  format: effectiveFormat,
                  paymentRunId: mode === 'RUN' ? runId : undefined,
                  paymentIds: mode === 'PAYMENTS' ? picked : undefined,
                  valueDate,
                  description: description || undefined,
                });
                toast.success(
                  `${f.documentNumber} generated: ${f.paymentCount} payment(s), ${formatMoney(f.totalAmount, f.currency)}.`,
                );
                onOpenChange(false);
                setPicked([]);
                onCreated(f.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PaymentFileDialog({
  id,
  onOpenChange,
}: {
  id: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const file = usePaymentFile(id);
  const download = useDownloadPaymentFile();
  const setStatus = useSetPaymentFileStatus();
  const [reject, setReject] = React.useState<'REJECTED' | 'CANCELLED' | null>(null);
  const [bankReference, setBankReference] = React.useState('');
  const f = file.data;
  const move = async (status: 'TRANSMITTED' | 'ACKNOWLEDGED') => {
    try {
      await setStatus.mutateAsync({ id: id!, status, bankReference: bankReference || undefined });
      toast.success(`${f!.documentNumber} marked ${status.toLowerCase()}.`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        {!f ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {f.documentNumber} <StatusBadge status={f.status} />
              </DialogTitle>
              <DialogDescription>
                {FORMAT_LABEL[f.format]} from {f.bankAccountCode} {f.bankAccountName}, value date{' '}
                {f.valueDate}
                {f.paymentRunNumber ? ` (run ${f.paymentRunNumber})` : ''}.
              </DialogDescription>
            </DialogHeader>
            <DescriptionList
              items={[
                [
                  'Total',
                  `${formatMoney(f.totalAmount, f.currency)} for ${f.paymentCount} payment(s)`,
                ],
                ['File', f.filename],
                [
                  'SHA-256',
                  <span key="c" className="break-all font-mono text-xs">
                    {f.checksum}
                  </span>,
                ],
                ['Transmitted', f.transmittedAt ? formatDateTime(f.transmittedAt) : '-'],
                ['Acknowledged', f.acknowledgedAt ? formatDateTime(f.acknowledgedAt) : '-'],
                ['Bank reference', f.bankReference ?? '-'],
                ['Note', f.statusNote ?? '-'],
              ]}
            />
            <div className="max-h-64 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>#</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead>Beneficiary</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {f.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs">{l.sequence}</TableCell>
                      <TableCell>
                        <Link
                          href={`${AP_CONFIG.payment.path}/${l.paymentId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {l.paymentNumber}
                        </Link>
                        <div className="text-xs text-muted-foreground">{l.remittanceInfo}</div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {l.beneficiaryName}
                        <div className="text-muted-foreground">{l.vendorName}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {l.beneficiaryAccountMasked ?? '-'}
                        <div className="text-muted-foreground">
                          {l.beneficiaryBank ?? ''} {l.beneficiaryRouting ?? ''}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Amount value={l.amount} currency={f.currency} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Can permissions={[P['payment-file.manage']]}>
              {f.status === 'GENERATED' || f.status === 'TRANSMITTED' ? (
                <Field
                  label="Bank reference"
                  hint="Batch or confirmation number from the bank portal"
                >
                  <Input value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
                </Field>
              ) : null}
              <DialogFooter className="flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={download.isPending}
                  onClick={async () => {
                    try {
                      const name = await download.mutateAsync(f.id);
                      toast.success(`${name} downloaded.`);
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  <Download /> Download
                </Button>
                {f.status === 'GENERATED' ? (
                  <Button disabled={setStatus.isPending} onClick={() => move('TRANSMITTED')}>
                    Mark transmitted
                  </Button>
                ) : null}
                {f.status === 'TRANSMITTED' ? (
                  <Button disabled={setStatus.isPending} onClick={() => move('ACKNOWLEDGED')}>
                    Mark acknowledged
                  </Button>
                ) : null}
                {f.status === 'TRANSMITTED' || f.status === 'GENERATED' ? (
                  <Button
                    variant="ghost"
                    onClick={() => setReject(f.status === 'TRANSMITTED' ? 'REJECTED' : 'CANCELLED')}
                  >
                    {f.status === 'TRANSMITTED' ? 'Bank rejected' : 'Cancel file'}
                  </Button>
                ) : null}
              </DialogFooter>
            </Can>
            <ReasonDialog
              open={reject !== null}
              onOpenChange={(o) => !o && setReject(null)}
              title={
                reject === 'REJECTED'
                  ? `Record the bank's rejection of ${f.documentNumber}`
                  : `Cancel ${f.documentNumber}`
              }
              description="The payments stay posted and become eligible for a new file."
              label="Note"
              confirmLabel={reject === 'REJECTED' ? 'Record rejection' : 'Cancel file'}
              destructive
              loading={setStatus.isPending}
              onConfirm={async (note) => {
                try {
                  await setStatus.mutateAsync({
                    id: f.id,
                    status: reject!,
                    note,
                    bankReference: bankReference || undefined,
                  });
                  toast.success(`${f.documentNumber} ${reject!.toLowerCase()}.`);
                  setReject(null);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
