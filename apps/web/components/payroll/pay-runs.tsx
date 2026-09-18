'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSession } from '@/lib/auth/session';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArrowLeft,
  Banknote,
  Calculator,
  CheckCircle2,
  Plus,
  Send,
  Trash2,
  Undo2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@accounting/money';
import type { PayFrequency } from '@accounting/types';
import { P, PAY_FREQUENCIES, PAY_RUN_STATUSES } from '@accounting/types';
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
  StepTimeline,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  type TimelineStep,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreatePayRun,
  useDeletePayRun,
  useEmployees,
  usePayItems,
  usePayPayRun,
  usePayRun,
  usePayRunAction,
  usePayRuns,
  usePayrollSettings,
  usePayslip,
  useReopenPayRun,
  useReversePayRun,
  useSetPayRunInputs,
} from '@/lib/api/payroll-hooks';
import type { PayRun, PayRunDetail, Payslip } from '@/lib/api/payroll-types';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import {
  APPROVAL_STEPS,
  OperationDialog,
  POSTING_STEPS,
} from '@/components/accounting/operation-dialog';
import { Amount, today } from '@/components/accounting/primitives';
import { BankAccountSelect } from '@/components/banking/shared';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Field, Kpi, ReasonDialog, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';
import { FREQUENCY_LABEL } from './employees';
import { ITEM_TYPE_LABEL } from './pay-items';

function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function PayRunsPage() {
  const router = useAppRouter();
  const table = useTableState();
  const [status, setStatus] = React.useState('ALL');
  const [creating, setCreating] = React.useState(false);
  const runs = usePayRuns({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as PayRun['status']),
  });
  const columns = React.useMemo<ColumnDef<PayRun>[]>(
    () => [
      {
        id: 'number',
        header: 'Run',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-mono text-sm">{row.original.documentNumber}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.description ?? FREQUENCY_LABEL[row.original.payFrequency]}
            </div>
          </div>
        ),
      },
      {
        id: 'period',
        header: 'Period',
        enableSorting: false,
        cell: ({ row }) =>
          `${formatDate(row.original.periodStart)} - ${formatDate(row.original.periodEnd)}`,
      },
      {
        id: 'pay',
        header: 'Pay date',
        enableSorting: false,
        cell: ({ row }) => formatDate(row.original.payDate),
      },
      {
        id: 'employees',
        header: 'Employees',
        enableSorting: false,
        cell: ({ row }) => row.original.employeeCount,
      },
      {
        id: 'gross',
        header: () => <span className="block text-right">Gross</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.grossTotal} currency={row.original.currency} zeroAsDash />
        ),
      },
      {
        id: 'net',
        header: () => <span className="block text-right">Net pay</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.netTotal} currency={row.original.currency} zeroAsDash />
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
        title="Pay Runs"
        description="Calculate payslips for a period, approve them (four-eyes), post one payroll journal on the period end and pay the net from the bank. Posted expense claims of linked employees ride along."
        actions={
          <Can permissions={[P['payroll.manage']]}>
            <Button size="sm" onClick={() => setCreating(true)} data-testid="pay-run-new">
              <Plus /> New pay run
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
        onRowClick={(r) => router.push(`/payroll/runs/${r.id}`)}
        emptyState={
          <EmptyState
            icon={Wallet}
            title="No pay runs"
            description="Create a run for the current pay period."
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
            <SelectTrigger className="w-40" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {PAY_RUN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <NewRunDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NewRunDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useAppRouter();
  const settings = usePayrollSettings();
  const create = useCreatePayRun();
  const [form, setForm] = React.useState({
    payFrequency: 'MONTHLY' as PayFrequency,
    periodStart: `${today().slice(0, 7)}-01`,
    periodEnd: endOfMonth(today()),
    payDate: endOfMonth(today()),
    description: '',
    currency: '',
  });
  React.useEffect(() => {
    if (open && settings.data)
      setForm((f) => ({ ...f, payFrequency: settings.data!.defaultPayFrequency }));
  }, [open, settings.data]);
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New pay run</DialogTitle>
          <DialogDescription>
            Every active employee on this frequency whose employment covers the period is included
            when you calculate.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pay frequency">
            <Select
              value={form.payFrequency}
              onValueChange={(v) => setForm((f) => ({ ...f, payFrequency: v as PayFrequency }))}
            >
              <SelectTrigger aria-label="Pay frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAY_FREQUENCIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {FREQUENCY_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Monthly payroll"
            />
          </Field>
          <Field label="Period start">
            <Input
              type="date"
              value={form.periodStart}
              onChange={(e) => setForm((f) => ({ ...f, periodStart: e.target.value }))}
              data-testid="run-period-start"
            />
          </Field>
          <Field label="Period end">
            <Input
              type="date"
              value={form.periodEnd}
              onChange={(e) => setForm((f) => ({ ...f, periodEnd: e.target.value }))}
              data-testid="run-period-end"
            />
          </Field>
          <Field label="Pay date">
            <Input
              type="date"
              value={form.payDate}
              onChange={(e) => setForm((f) => ({ ...f, payDate: e.target.value }))}
              data-testid="run-pay-date"
            />
          </Field>
          <Field label="Pay currency">
            <Input
              placeholder="Company base"
              maxLength={3}
              className="font-mono uppercase"
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              data-testid="run-currency"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            disabled={create.isPending}
            data-testid="run-create"
            onClick={async () => {
              try {
                const run = await create.mutateAsync({
                  ...form,
                  description: form.description || undefined,
                  currency: form.currency.trim() ? form.currency.trim().toUpperCase() : undefined,
                });
                onClose();
                router.push(`/payroll/runs/${run.id}`);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------- detail

function timeline(r: PayRun): TimelineStep[] {
  const meta = (when: string | null) => (when ? formatDateTime(when) : undefined);
  const order: PayRun['status'][] = ['DRAFT', 'CALCULATED', 'APPROVED', 'POSTED', 'PAID'];
  const idx = order.indexOf(r.status);
  const state = (i: number): TimelineStep['state'] =>
    r.status === 'REVERSED'
      ? i <= 3
        ? 'complete'
        : 'skipped'
      : i < idx
        ? 'complete'
        : i === idx
          ? 'current'
          : 'upcoming';
  const steps: TimelineStep[] = [
    {
      key: 'created',
      label: 'Created',
      state: 'complete',
      meta: meta(r.createdAt),
      description: r.createdByName ?? undefined,
    },
    { key: 'calculated', label: 'Calculated', state: state(1), meta: meta(r.calculatedAt) },
    {
      key: 'approved',
      label: 'Approved',
      state: state(2),
      meta: meta(r.approvedAt),
      description: r.approvedByName ?? undefined,
    },
    {
      key: 'posted',
      label: 'Posted to the ledger',
      state: state(3),
      meta: meta(r.postedAt),
      description: r.journalNumber ?? undefined,
    },
    {
      key: 'paid',
      label: 'Paid',
      state: state(4),
      meta: meta(r.paidAt),
      description: r.paymentJournalNumber
        ? `${r.paymentJournalNumber} - ${r.bankAccountCode ?? ''}`
        : undefined,
    },
  ];
  if (r.status === 'REVERSED')
    steps.push({
      key: 'reversed',
      label: 'Reversed',
      state: 'failed',
      meta: meta(r.reversedAt),
      description: r.reversalReason ?? undefined,
    });
  return steps;
}

export function PayRunDetailPage({ id }: { id: string }) {
  const router = useAppRouter();
  const { activeCompany } = useSession();
  const baseCurrency = activeCompany?.baseCurrency ?? 'PHP';
  const run = usePayRun(id);
  const action = usePayRunAction();
  const reopen = useReopenPayRun();
  const pay = usePayPayRun();
  const reverse = useReversePayRun();
  const remove = useDeletePayRun();
  const [pending, setPending] = React.useState<'approve' | 'post' | null>(null);
  const [paying, setPaying] = React.useState(false);
  const [reversing, setReversing] = React.useState(false);
  const [reopening, setReopening] = React.useState(false);
  const [editingInputs, setEditingInputs] = React.useState(false);
  const [bankAccountId, setBankAccountId] = React.useState<string | null>(null);
  const [paymentDate, setPaymentDate] = React.useState('');
  const simple = async (a: 'calculate' | 'submit', label: string) => {
    try {
      await action.mutateAsync({ id, action: a });
      toast.success(label);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <QueryState query={run}>
      {(r) => (
        <>
          <PageHeader
            eyebrow={
              <Link href="/payroll/runs" className="inline-flex items-center gap-1 text-xs">
                <ArrowLeft className="h-3 w-3" /> Pay runs
              </Link>
            }
            title={r.documentNumber}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge status={r.status} /> {FREQUENCY_LABEL[r.payFrequency]} -{' '}
                {formatDate(r.periodStart)} to {formatDate(r.periodEnd)} - pay date{' '}
                {formatDate(r.payDate)}
                {r.description ? ` - ${r.description}` : ''}
              </span>
            }
            actions={
              <div className="flex flex-wrap gap-2">
                {r.status === 'DRAFT' || r.status === 'CALCULATED' ? (
                  <Can permissions={[P['payroll.manage']]}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingInputs(true)}
                      data-testid="run-inputs"
                    >
                      Inputs ({r.inputs.length})
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void simple('calculate', 'Payslips calculated')}
                      disabled={action.isPending}
                      data-testid="run-calculate"
                    >
                      <Calculator /> {r.status === 'DRAFT' ? 'Calculate' : 'Recalculate'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await remove.mutateAsync(id);
                          router.push('/payroll/runs');
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                      aria-label="Delete run"
                    >
                      <Trash2 />
                    </Button>
                  </Can>
                ) : null}
                {r.status === 'CALCULATED' ? (
                  <>
                    <Can permissions={[P['payroll.manage']]}>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void simple('submit', 'Submitted for approval')}
                        disabled={action.isPending || Boolean(r.submittedAt)}
                      >
                        <Send /> {r.submittedAt ? 'Submitted' : 'Submit'}
                      </Button>
                    </Can>
                    <Can permissions={[P['payroll.approve']]}>
                      <Button
                        size="sm"
                        onClick={() => setPending('approve')}
                        data-testid="run-approve"
                      >
                        <CheckCircle2 /> Approve
                      </Button>
                    </Can>
                  </>
                ) : null}
                {r.status === 'APPROVED' ? (
                  <>
                    <Can permissions={[P['payroll.approve']]}>
                      <Button size="sm" variant="outline" onClick={() => setReopening(true)}>
                        Reopen
                      </Button>
                    </Can>
                    <Can permissions={[P['payroll.post']]}>
                      <Button size="sm" onClick={() => setPending('post')} data-testid="run-post">
                        <Banknote /> Post journal
                      </Button>
                    </Can>
                  </>
                ) : null}
                {r.status === 'POSTED' ? (
                  <Can permissions={[P['payroll.post']]}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReversing(true)}
                      data-testid="run-reverse"
                    >
                      <Undo2 /> Reverse
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setBankAccountId(r.bankAccountId);
                        setPaymentDate(r.payDate);
                        setPaying(true);
                      }}
                      data-testid="run-pay"
                    >
                      <Wallet /> Pay
                    </Button>
                  </Can>
                ) : null}
              </div>
            }
          />
          <div className="grid gap-3 sm:grid-cols-6">
            <Kpi label="Employees" value={r.employeeCount} />
            <Kpi label="Gross" value={r.grossTotal} currency={r.currency} />
            <Kpi label="Withholding" value={r.withholdingTotal} currency={r.currency} />
            <Kpi label="Deductions" value={r.deductionTotal} currency={r.currency} />
            <Kpi
              label="Employer cost"
              value={r.employerTotal}
              currency={r.currency}
              hint="contributions on top of gross"
            />
            <Kpi
              label="Net pay"
              value={r.netTotal}
              currency={r.currency}
              hint={
                Number(r.exchangeRate) !== 1
                  ? `in the ledger ${formatMoney(r.netTotalBase, baseCurrency)} at ${Number(r.exchangeRate)}${r.paidBase ? ` · paid ${formatMoney(r.paidBase, baseCurrency)}` : ''}`
                  : Number(r.reimbursementTotal)
                    ? `incl. ${formatMoney(r.reimbursementTotal, r.currency)} claims`
                    : undefined
              }
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Payslips</CardTitle>
                <CardDescription>
                  {r.status === 'DRAFT'
                    ? 'Calculate the run to build payslips.'
                    : 'One per employee; open a row for the lines.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Employee</TableHead>
                      <TableHead className="text-right">Gross</TableHead>
                      <TableHead className="text-right">Taxable</TableHead>
                      <TableHead className="text-right">Withholding</TableHead>
                      <TableHead className="text-right">Deductions</TableHead>
                      <TableHead className="text-right">Employer</TableHead>
                      <TableHead className="text-right">Net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.payslips.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                          No payslips yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      r.payslips.map((p) => (
                        <TableRow
                          key={p.id}
                          className="cursor-pointer"
                          onClick={() => router.push(`/payroll/payslips/${p.id}`)}
                          data-testid="payslip-row"
                        >
                          <TableCell>
                            <div>{p.employeeName}</div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {p.employeeNumber}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Amount value={p.gross} currency={r.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={p.taxable} currency={r.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={p.withholding} currency={r.currency} zeroAsDash />
                          </TableCell>
                          <TableCell>
                            <Amount value={p.deductions} currency={r.currency} zeroAsDash />
                          </TableCell>
                          <TableCell>
                            <Amount
                              value={p.employerContributions}
                              currency={r.currency}
                              zeroAsDash
                            />
                          </TableCell>
                          <TableCell>
                            <Amount value={p.net} currency={r.currency} className="font-medium" />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                  {r.payslips.length ? (
                    <TableFooter>
                      <TableRow>
                        <TableCell>Total</TableCell>
                        <TableCell>
                          <Amount value={r.grossTotal} currency={r.currency} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.taxableTotal} currency={r.currency} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.withholdingTotal} currency={r.currency} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.deductionTotal} currency={r.currency} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.employerTotal} currency={r.currency} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.netTotal} currency={r.currency} />
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  ) : null}
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Lifecycle</CardTitle>
              </CardHeader>
              <CardContent>
                <StepTimeline steps={timeline(r)} />
                {r.journalEntryId ? (
                  <Button variant="link" size="sm" className="mt-2 px-0" asChild>
                    <Link href={`/accounting/journal-entries/${r.journalEntryId}`}>
                      Open payroll journal
                    </Link>
                  </Button>
                ) : null}
                {r.paymentJournalEntryId ? (
                  <Button variant="link" size="sm" className="px-0" asChild>
                    <Link href={`/accounting/journal-entries/${r.paymentJournalEntryId}`}>
                      Open payment journal
                    </Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <OperationDialog
            open={pending === 'approve'}
            onOpenChange={(o) => (!o ? setPending(null) : undefined)}
            title={`Approve ${r.documentNumber}`}
            description={`${r.employeeCount} payslip(s), net ${formatMoney(r.netTotal, r.currency)}. Approval is delegable and checked against the preparer.`}
            confirmLabel="Approve run"
            loadingLabel="Approving"
            resultLabel="APPROVED"
            steps={APPROVAL_STEPS}
            run={() => action.mutateAsync({ id, action: 'approve' })}
            onDone={() => toast.success('Pay run approved')}
          />
          <OperationDialog
            open={pending === 'post'}
            onOpenChange={(o) => (!o ? setPending(null) : undefined)}
            title={`Post ${r.documentNumber}`}
            description={`One journal dated ${formatDate(r.periodEnd)}: Dr salaries ${formatMoney(r.grossTotal, r.currency)} and employer cost ${formatMoney(r.employerTotal, r.currency)}; Cr withholding, statutory payables and the employee payable.`}
            confirmLabel="Post journal"
            loadingLabel="Posting"
            resultLabel="POSTED"
            steps={POSTING_STEPS}
            run={() => action.mutateAsync({ id, action: 'post' })}
            onDone={() => toast.success('Payroll posted')}
          />
          <Dialog open={paying} onOpenChange={setPaying}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Pay {r.documentNumber}</DialogTitle>
                <DialogDescription>
                  Dr employee payable / Cr bank for {formatMoney(r.netTotal, r.currency)}
                  {Number(r.reimbursementTotal)
                    ? `, settling ${formatMoney(r.reimbursementTotal, r.currency)} of expense claims`
                    : ''}
                  .
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3">
                <Field label="Bank account">
                  <BankAccountSelect
                    value={bankAccountId}
                    onChange={setBankAccountId}
                    testId="pay-bank"
                  />
                </Field>
                <Field label="Payment date">
                  <Input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                  />
                </Field>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setPaying(false)} disabled={pay.isPending}>
                  Cancel
                </Button>
                <Button
                  disabled={pay.isPending || !bankAccountId}
                  data-testid="pay-confirm"
                  onClick={async () => {
                    try {
                      await pay.mutateAsync({ id, bankAccountId: bankAccountId!, paymentDate });
                      toast.success('Payroll paid');
                      setPaying(false);
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  Pay from bank
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <ReasonDialog
            open={reversing}
            onOpenChange={setReversing}
            title={`Reverse ${r.documentNumber}`}
            description="Mirrors the payroll journal. Paid runs cannot be reversed."
            confirmLabel="Reverse run"
            destructive
            loading={reverse.isPending}
            onConfirm={async (reason) => {
              try {
                await reverse.mutateAsync({ id, reason });
                toast.success('Pay run reversed');
                setReversing(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          />
          <ReasonDialog
            open={reopening}
            onOpenChange={setReopening}
            title={`Reopen ${r.documentNumber}`}
            description="Back to calculated so inputs can change; the approval is withdrawn."
            confirmLabel="Reopen"
            loading={reopen.isPending}
            onConfirm={async (reason) => {
              try {
                await reopen.mutateAsync({ id, reason });
                setReopening(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          />
          <InputsDialog open={editingInputs} onClose={() => setEditingInputs(false)} run={r} />
        </>
      )}
    </QueryState>
  );
}

function InputsDialog({
  open,
  onClose,
  run,
}: {
  open: boolean;
  onClose: () => void;
  run: PayRunDetail;
}) {
  const employees = useEmployees({
    pageSize: 200,
    status: 'ACTIVE',
    payFrequency: run.payFrequency,
  });
  const items = usePayItems();
  const save = useSetPayRunInputs();
  const [rows, setRows] = React.useState<
    Array<{ employeeId: string; payItemId: string; amount: string; note: string }>
  >([]);
  React.useEffect(() => {
    if (open)
      setRows(
        run.inputs.map((i) => ({
          employeeId: i.employeeId,
          payItemId: i.payItemId,
          amount: String(Number(i.amount)),
          note: i.note ?? '',
        })),
      );
  }, [open, run.inputs]);
  const candidates = (items.data ?? []).filter(
    (i) =>
      i.status === 'ACTIVE' &&
      i.calculation !== 'BASE_SALARY' &&
      i.calculation !== 'BRACKET' &&
      i.calculation !== 'PERCENT_OF_GROSS',
  );
  const setRow = (i: number, patch: Partial<(typeof rows)[number]>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>One-off inputs for {run.documentNumber}</DialogTitle>
          <DialogDescription>
            Overtime, bonuses, unpaid leave. An input replaces the item&apos;s recurring amount for
            that employee; saving returns the run to draft.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_1fr_7rem_1fr_auto] items-center gap-1"
              data-testid="input-row"
            >
              <Select value={row.employeeId} onValueChange={(v) => setRow(i, { employeeId: v })}>
                <SelectTrigger className="h-8" aria-label="Employee">
                  <SelectValue placeholder="Employee" />
                </SelectTrigger>
                <SelectContent>
                  {(employees.data?.items ?? []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={row.payItemId} onValueChange={(v) => setRow(i, { payItemId: v })}>
                <SelectTrigger className="h-8" aria-label="Pay item">
                  <SelectValue placeholder="Pay item" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} - {ITEM_TYPE_LABEL[c.type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="h-8"
                inputMode="decimal"
                placeholder="Amount"
                value={row.amount}
                onChange={(e) => setRow(i, { amount: e.target.value })}
                data-testid="input-amount"
              />
              <Input
                className="h-8"
                placeholder="Note"
                value={row.note}
                onChange={(e) => setRow(i, { note: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove input"
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              setRows((r) => [...r, { employeeId: '', payItemId: '', amount: '', note: '' }])
            }
            data-testid="input-add"
          >
            <Plus /> Add input
          </Button>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            disabled={
              save.isPending || rows.some((r) => !r.employeeId || !r.payItemId || !r.amount)
            }
            data-testid="input-save"
            onClick={async () => {
              try {
                await save.mutateAsync({
                  id: run.id,
                  inputs: rows.map((r) => ({
                    employeeId: r.employeeId,
                    payItemId: r.payItemId,
                    amount: r.amount,
                    note: r.note || undefined,
                  })),
                });
                toast.success('Inputs saved - recalculate the run');
                onClose();
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Save inputs
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- payslip

export function PayslipPage({ id }: { id: string }) {
  const slip = usePayslip(id);
  return (
    <QueryState query={slip}>
      {(p) => (
        <PayslipCard
          payslip={p}
          currency={p.run.currency}
          runNumber={p.run.documentNumber}
          runId={p.run.id}
          period={`${formatDate(p.run.periodStart)} - ${formatDate(p.run.periodEnd)}`}
        />
      )}
    </QueryState>
  );
}

function PayslipCard({
  payslip: p,
  currency,
  runNumber,
  runId,
  period,
}: {
  payslip: Payslip;
  currency: string;
  runNumber: string;
  runId: string;
  period: string;
}) {
  const group = (type: string) => p.lines.filter((l) => l.type === type);
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/payroll/runs/${runId}`} className="inline-flex items-center gap-1 text-xs">
            <ArrowLeft className="h-3 w-3" /> {runNumber}
          </Link>
        }
        title={`Payslip - ${p.employeeName}`}
        description={`${p.employeeNumber} - ${period} - paid by ${titleCase(p.paymentMethod)}${p.bankName ? ` to ${p.bankName} ${p.bankAccountNumber ?? ''}` : ''}`}
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <Kpi label="Gross pay" value={p.gross} currency={currency} />
        <Kpi label="Taxable pay" value={p.taxable} currency={currency} />
        <Kpi
          label="Total deductions"
          value={String(Number(p.deductions) + Number(p.withholding))}
          currency={currency}
        />
        <Kpi label="Net pay" value={p.net} currency={currency} tone="success" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {(['EARNING', 'DEDUCTION', 'WITHHOLDING_TAX', 'EMPLOYER_CONTRIBUTION'] as const).map(
          (type) => (
            <Card key={type} data-testid={`payslip-${type.toLowerCase()}`}>
              <CardHeader>
                <CardTitle className="text-sm">
                  {ITEM_TYPE_LABEL[type]}
                  {type === 'EMPLOYER_CONTRIBUTION' ? ' (not deducted)' : ''}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {group(type).length === 0 ? (
                      <TableRow>
                        <TableCell className="py-4 text-center text-muted-foreground">
                          None
                        </TableCell>
                      </TableRow>
                    ) : (
                      group(type).map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>
                            <div>{l.description}</div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {l.code} - {l.source.toLowerCase()}
                              {l.type === 'EARNING' && !l.taxable ? ' - non-taxable' : ''}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Amount value={l.amount} currency={currency} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ),
        )}
      </div>
    </>
  );
}
