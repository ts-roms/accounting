'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, CheckCircle2, Play, Plus, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Money, formatMoney } from '@accounting/money';
import { P } from '@accounting/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useApAccrual,
  useApAccrualAction,
  useApAccruals,
  useApIntegrity,
  useApReconciliation,
  useBillHolds,
  useCashRequirements,
  useCreateApAccrual,
  useGrni,
  useReleaseBillHold,
  useRunPayablesSweep,
} from '@/lib/api/payables-hooks';
import type { ApAccrual, BillHold } from '@/lib/api/payables-types';
import { AP_CONFIG } from '@/lib/subledger/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import {
  BarChart,
  DescriptionList,
  Field,
  ReasonDialog,
  StatusBadge,
} from '@/components/receivables/shared';

// ---------------------------------------------------------- reconciliation

export function ApReconciliationPage() {
  const [asOf, setAsOf] = React.useState(today());
  const rec = useApReconciliation(asOf);
  const integrity = useApIntegrity(asOf);
  const r = rec.data;
  const i = integrity.data;
  return (
    <>
      <PageHeader
        title="AP Reconciliation"
        description="The AP subledger (posted bills, vendor credits, payments, refunds, discounts and FX) must equal the AP control account in the general ledger."
        actions={
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-40"
            aria-label="As of"
          />
        }
      />
      {!r ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {r.reconciled ? (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>Reconciled</AlertTitle>
              <AlertDescription>
                AP subledger and GL control account {r.controlAccount.code} agree as of {r.asOf}.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Reconciliation difference</AlertTitle>
              <AlertDescription>
                The subledger differs from the control account by {r.difference}. Review the
                integrity findings below.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile label="AP subledger" value={r.subledgerBalance} />
            <Tile
              label={`GL ${r.controlAccount.code} ${r.controlAccount.name}`}
              value={r.ledgerBalance}
            />
            <Tile label="Difference" value={r.difference} danger={!r.reconciled} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Subledger build-up</CardTitle>
                <CardDescription>
                  Discounts are already inside payments (control amount) and shown for transparency.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {Object.entries(r.breakdown).map(([k, v]) => (
                      <TableRow key={k}>
                        <TableCell>{titleCase(k.replace(/([A-Z])/g, '_$1'))}</TableCell>
                        <TableCell>
                          <Amount value={v} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow className="hover:bg-transparent">
                      <TableCell>Subledger balance</TableCell>
                      <TableCell>
                        <Amount value={r.subledgerBalance} className="font-semibold" />
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm">AP integrity checks</CardTitle>
                  <CardDescription>
                    {i ? `Ran ${formatDateTime(i.ranAt)}` : 'Running...'}
                  </CardDescription>
                </div>
                {i ? <StatusBadge status={i.status} /> : null}
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {(i?.findings ?? []).map((f) => (
                      <TableRow key={f.check}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {f.count ? (
                              <AlertTriangle
                                className={`h-4 w-4 ${f.severity === 'CRITICAL' ? 'text-destructive' : 'text-warning'}`}
                              />
                            ) : (
                              <CheckCircle2 className="h-4 w-4 text-success" />
                            )}
                            <span>{f.title}</span>
                          </div>
                          {f.count ? (
                            <ul className="ml-6 mt-1 list-disc text-xs text-muted-foreground">
                              {f.samples.slice(0, 3).map((s, idx) => (
                                <li key={idx}>
                                  {Object.entries(s)
                                    .map(([k, v]) => `${k}: ${String(v)}`)
                                    .join(', ')}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge
                            variant={
                              f.count
                                ? f.severity === 'CRITICAL'
                                  ? 'destructive'
                                  : 'warning'
                                : 'success'
                            }
                          >
                            {f.count}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function Tile({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <Amount
          value={value}
          className={`text-lg font-semibold ${danger ? 'text-destructive' : ''}`}
        />
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------- cash requirements

export function CashRequirementsPage() {
  const [asOf, setAsOf] = React.useState(today());
  const report = useCashRequirements({ asOf });
  const sweep = useRunPayablesSweep();
  const r = report.data;
  const n = (v: string) => Number(Money.of(v, r?.currency ?? 'PHP').toString());
  return (
    <>
      <PageHeader
        title="Cash Requirements"
        description="Cash needed to settle open bills by horizon, with discounts still obtainable. Held bills are listed but excluded from the totals."
        actions={
          <>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-40"
              aria-label="As of"
            />
            <Can permissions={[P['ap-settings.manage']]}>
              <Button
                variant="outline"
                size="sm"
                disabled={sweep.isPending}
                onClick={async () => {
                  try {
                    const s = await sweep.mutateAsync(asOf);
                    toast.success(
                      `Sweep: ${s.overdue} overdue, ${s.dueSoon} due soon, ${s.discountsExpiring} discount(s) lapsing, ${s.agedGrniLines} aged GRNI line(s).`,
                    );
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                <Play /> Run payables sweep
              </Button>
            </Can>
          </>
        }
      />
      {!r ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <BarChart
                title="Cash by horizon"
                description={`As of ${r.asOf}; held bills ${formatMoney(r.onHold, r.currency)} excluded`}
                categories={r.buckets.map((b) => b.label)}
                series={[
                  { name: 'To pay', values: r.buckets.map((b) => n(b.amount)) },
                  {
                    name: 'Discount available',
                    values: r.buckets.map((b) => n(b.discountAvailable)),
                  },
                ]}
              />
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Horizons</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {r.buckets.map((b) => (
                      <TableRow key={b.label}>
                        <TableCell>
                          {b.label}
                          <div className="text-xs text-muted-foreground">{b.billCount} bill(s)</div>
                        </TableCell>
                        <TableCell>
                          <Amount value={b.amount} />
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell>On hold</TableCell>
                      <TableCell>
                        <Amount value={r.onHold} className="text-warning" />
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Open bills by due date</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Due</TableHead>
                    <TableHead>Bill</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Discount until</TableHead>
                    <TableHead className="text-right">Discount</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.bills.map((b) => (
                    <TableRow key={b.billId} className={b.onHold ? 'opacity-60' : undefined}>
                      <TableCell className="whitespace-nowrap">
                        {b.dueDate}
                        {b.dueDate < r.asOf ? (
                          <Badge variant="destructive" className="ml-2">
                            overdue
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`${AP_CONFIG.document.path}/${b.billId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {b.documentNumber}
                        </Link>
                        {b.vendorInvoiceNumber ? (
                          <div className="text-xs text-muted-foreground">
                            {b.vendorInvoiceNumber}
                          </div>
                        ) : null}
                        {b.onHold ? <Badge variant="warning">on hold</Badge> : null}
                      </TableCell>
                      <TableCell>{b.vendorName}</TableCell>
                      <TableCell>{b.discountDate ?? '-'}</TableCell>
                      <TableCell>
                        <Amount value={b.discountAvailable} className="text-success" />
                      </TableCell>
                      <TableCell>
                        <Amount value={b.openAmount} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------- bill holds

export function BillHoldsPage() {
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('ACTIVE');
  const release = useReleaseBillHold();
  const [releasing, setReleasing] = React.useState<BillHold | null>(null);
  const holds = useBillHolds({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as BillHold['status']),
  });
  const columns = React.useMemo<ColumnDef<BillHold>[]>(
    () => [
      {
        id: 'bill',
        header: 'Bill',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <Link
              href={`${AP_CONFIG.document.path}/${row.original.billId}`}
              className="font-mono text-sm hover:underline"
            >
              {row.original.billNumber}
            </Link>
            <div className="text-xs text-muted-foreground">
              {row.original.vendorInvoiceNumber ?? ''}
            </div>
          </div>
        ),
      },
      {
        id: 'vendor',
        header: 'Vendor',
        enableSorting: false,
        cell: ({ row }) => row.original.vendorName,
      },
      {
        id: 'reason',
        header: 'Reason',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-sm">
            <div>{titleCase(row.original.reason)}</div>
            <div className="truncate text-xs text-muted-foreground">{row.original.note}</div>
          </div>
        ),
      },
      {
        id: 'placed',
        header: 'Placed',
        enableSorting: false,
        cell: ({ row }) => formatDateTime(row.original.placedAt),
      },
      {
        id: 'balance',
        header: () => <div className="text-right">Balance</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.billBalance} />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === 'ACTIVE' ? (
            <Can permissions={[P['bill.hold']]}>
              <Button size="sm" variant="outline" onClick={() => setReleasing(row.original)}>
                Release
              </Button>
            </Can>
          ) : null,
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Payment Holds"
        description="Bills kept out of payment runs and settlement until released. The liability stays posted."
      />
      <DataTable
        columns={columns}
        data={holds.data}
        isLoading={holds.isLoading}
        isFetching={holds.isFetching}
        pagination={table.pagination}
        getRowId={(h) => h.id}
        emptyState={
          <EmptyState
            icon={ShieldAlert}
            title="No payment holds"
            description="Place a hold from a bill when its price, quantity or quality is in question."
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
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="RELEASED">Released</SelectItem>
              <SelectItem value="ALL">All</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <ReasonDialog
        open={Boolean(releasing)}
        onOpenChange={(o) => !o && setReleasing(null)}
        title={releasing ? `Release hold on ${releasing.billNumber}` : ''}
        label="Note"
        required={false}
        confirmLabel="Release"
        loading={release.isPending}
        onConfirm={async (note) => {
          try {
            await release.mutateAsync({ id: releasing!.id, note: note || undefined });
            toast.success(`${releasing!.billNumber} released for payment.`);
            setReleasing(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

// ------------------------------------------------------- GRNI + accruals

export function GrniPage() {
  const [asOf, setAsOf] = React.useState(today());
  const [agedOnly, setAgedOnly] = React.useState(false);
  const grni = useGrni({ asOf });
  const g = grni.data;
  const rows = (g?.rows ?? []).filter((r) => !agedOnly || r.aged);
  return (
    <>
      <PageHeader
        title="Received Not Billed"
        description="Purchase-order lines received but not yet billed. Stocked lines already sit in the GRNI clearing account; service lines are accrued at period end."
        actions={
          <>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-40"
              aria-label="As of"
            />
            <Button variant="outline" size="sm" asChild>
              <Link href="/payables/accruals">Accruals</Link>
            </Button>
          </>
        }
      />
      {!g ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Tile label="Received not billed" value={g.totals.total} />
            <Tile label="Stocked (in GRNI account)" value={g.totals.stocked} />
            <Tile label="Services (to accrue)" value={g.totals.unstocked} />
            <Tile label="Aged" value={g.totals.aged} danger={g.totals.aged !== '0.0000'} />
          </div>
          {g.difference !== '0.0000' ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>GRNI account differs from the received-not-billed value</AlertTitle>
              <AlertDescription>
                GL balance {formatMoney(g.grniAccountBalance, g.currency)} vs{' '}
                {formatMoney(g.totals.stocked, g.currency)} stocked lines (difference{' '}
                {formatMoney(g.difference, g.currency)}). Price variances on billing or
                foreign-currency receipts explain most differences.
              </AlertDescription>
            </Alert>
          ) : null}
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">Open receipt lines</CardTitle>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={agedOnly} onCheckedChange={(v) => setAgedOnly(v === true)} />{' '}
                Aged only
              </label>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Vendor</TableHead>
                    <TableHead>PO line</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Last receipt</TableHead>
                    <TableHead className="text-right">Open qty</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length ? (
                    rows.map((r) => (
                      <TableRow key={r.orderLineId}>
                        <TableCell>{r.vendorName}</TableCell>
                        <TableCell>
                          <Link
                            href={`/purchasing/orders/${r.orderId}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {r.orderNumber} L{r.lineNumber}
                          </Link>
                          <div className="max-w-xs truncate text-xs text-muted-foreground">
                            {r.description}
                          </div>
                          {r.stocked ? (
                            <Badge variant="outline">stocked</Badge>
                          ) : (
                            <Badge variant="secondary">service</Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.accountCode}</TableCell>
                        <TableCell>
                          {r.lastReceiptDate ?? '-'}{' '}
                          {r.aged ? <Badge variant="warning">{r.ageDays}d</Badge> : null}
                        </TableCell>
                        <TableCell className="text-right tabular">{r.openQuantity}</TableCell>
                        <TableCell>
                          <Amount value={r.amount} />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Everything received has been billed.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

export function ApAccrualsPage() {
  const table = useTableState({ sortDir: 'desc' });
  const accruals = useApAccruals(table.query);
  const [create, setCreate] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const columns = React.useMemo<ColumnDef<ApAccrual>[]>(
    () => [
      {
        id: 'number',
        header: 'Accrual',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-sm">{row.original.documentNumber}</span>,
      },
      {
        id: 'dates',
        header: 'Accrue / reverse',
        enableSorting: false,
        cell: ({ row }) => `${row.original.accrualDate} / ${row.original.reversalDate}`,
      },
      {
        id: 'source',
        header: 'Source',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.source),
      },
      {
        id: 'description',
        header: 'Description',
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs">{row.original.description ?? '-'}</span>,
      },
      {
        id: 'journal',
        header: 'Journal',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.journalNumber ?? '-'}</span>
        ),
      },
      {
        id: 'total',
        header: () => <div className="text-right">Amount</div>,
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
        title="AP Accruals"
        description="Period-end accruals for goods and services received but not billed: Dr expense / Cr accrued expenses, auto-reversed on the first day of the next period."
        actions={
          <Can permissions={[P['ap-accrual.post']]}>
            <Button size="sm" onClick={() => setCreate(true)}>
              <Plus /> New accrual
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={accruals.data}
        isLoading={accruals.isLoading}
        isFetching={accruals.isFetching}
        pagination={table.pagination}
        getRowId={(a) => a.id}
        onRowClick={(a) => setSelected(a.id)}
        emptyState={
          <EmptyState
            icon={CheckCircle2}
            title="No accruals"
            description="Draft one from the received-not-billed analysis at period end."
          />
        }
      />
      <NewAccrualDialog
        open={create}
        onOpenChange={setCreate}
        onCreated={(id) => setSelected(id)}
      />
      <AccrualDialog id={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

function NewAccrualDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateApAccrual();
  const [accrualDate, setAccrualDate] = React.useState(today());
  const [reversalDate, setReversalDate] = React.useState('');
  const [description, setDescription] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Draft an accrual</DialogTitle>
          <DialogDescription>
            Computes the service lines received but not billed on the accrual date; review the lines
            before posting.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Accrual date (period end)">
            <Input
              type="date"
              value={accrualDate}
              onChange={(e) => setAccrualDate(e.target.value)}
            />
          </Field>
          <Field label="Reversal date (next period)">
            <Input
              type="date"
              value={reversalDate}
              onChange={(e) => setReversalDate(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!reversalDate || create.isPending}
            onClick={async () => {
              try {
                const a = await create.mutateAsync({
                  accrualDate,
                  reversalDate,
                  source: 'RECEIVED_NOT_BILLED',
                  description: description || undefined,
                });
                toast.success(`${a.documentNumber} drafted: ${a.lines.length} line(s).`);
                onOpenChange(false);
                onCreated(a.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccrualDialog({
  id,
  onOpenChange,
}: {
  id: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const accrual = useApAccrual(id);
  const action = useApAccrualAction();
  const a = accrual.data;
  const run = async (kind: 'post' | 'delete') => {
    try {
      await action.mutateAsync({ id: id!, action: kind });
      toast.success(
        kind === 'post' ? `${a?.documentNumber} posted with its reversal.` : 'Draft deleted.',
      );
      if (kind === 'delete') onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {!a ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {a.documentNumber} <StatusBadge status={a.status} />
              </DialogTitle>
              <DialogDescription>{a.description ?? titleCase(a.source)}</DialogDescription>
            </DialogHeader>
            <DescriptionList
              items={[
                ['Accrual date', a.accrualDate],
                ['Reversal date', a.reversalDate],
                ['Journal', a.journalNumber ?? '-'],
                [
                  'Total',
                  <Amount key="t" value={a.totalAmount} className="inline font-semibold" />,
                ],
              ]}
            />
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Line</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <div className="text-sm">{l.description}</div>
                      <div className="text-xs text-muted-foreground">{l.vendorName ?? ''}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{l.accountCode}</TableCell>
                    <TableCell>
                      <Amount value={l.amount} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {a.status === 'DRAFT' ? (
              <Can permissions={[P['ap-accrual.post']]}>
                <DialogFooter>
                  <Button variant="ghost" disabled={action.isPending} onClick={() => run('delete')}>
                    Delete draft
                  </Button>
                  <Button disabled={action.isPending} onClick={() => run('post')}>
                    Post accrual + reversal
                  </Button>
                </DialogFooter>
              </Can>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
