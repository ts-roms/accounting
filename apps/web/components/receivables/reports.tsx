'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, CheckCircle2, FileText, Search } from 'lucide-react';
import { toast } from 'sonner';
import { P, REFUND_REQUEST_STATUSES } from '@accounting/types';
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
  Input,
  Label,
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
  useArReconciliation,
  useGenerateStatement,
  useRefundAction,
  useRefunds,
  useStatementHistory,
  useUnappliedCash,
} from '@/lib/api/receivables-hooks';
import type { GeneratedStatement, RefundRequest } from '@/lib/api/receivables-types';
import { AR_CONFIG } from '@/lib/subledger/config';
import { useSession } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';
import { ReasonDialog, StatusBadge } from './shared';

// ---------------------------------------------------------- reconciliation

export function ArReconciliationPage() {
  const [asOf, setAsOf] = React.useState(today());
  const rec = useArReconciliation(asOf);
  const unapplied = useUnappliedCash(asOf);
  const r = rec.data;
  return (
    <>
      <PageHeader
        title="AR Reconciliation"
        description="The AR subledger (posted documents, receipts, refunds, write-offs and FX) must equal the AR control account in the general ledger."
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
                AR subledger and GL control account {r.controlAccount.code} agree as of {r.asOf}.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Reconciliation difference</AlertTitle>
              <AlertDescription>
                The subledger differs from the control account by {r.difference}. Review the
                integrity findings below and the Reconciliation Center.
              </AlertDescription>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Tile label="AR subledger" value={r.subledgerBalance} />
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
                  <CardTitle className="text-sm">AR integrity checks</CardTitle>
                  <CardDescription>Ran {formatDateTime(r.integrity.ranAt)}</CardDescription>
                </div>
                <StatusBadge status={r.integrity.status} />
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {r.integrity.findings.map((f) => (
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
                              {f.samples.slice(0, 3).map((s, i) => (
                                <li key={i}>
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
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Unapplied cash</CardTitle>
              <CardDescription>
                Posted receipts not yet applied to invoices; receipts older than{' '}
                {unapplied.data?.warnDays ?? 30} days are flagged.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Receipt</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Age</TableHead>
                    <TableHead className="text-right">Unapplied</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unapplied.data?.items.length ? (
                    unapplied.data.items.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell>
                          <Link
                            href={`${AR_CONFIG.payment.path}/${i.id}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {i.documentNumber}
                          </Link>
                        </TableCell>
                        <TableCell>{i.customerName}</TableCell>
                        <TableCell>{i.paymentDate}</TableCell>
                        <TableCell>
                          {i.stale ? (
                            <Badge variant="warning">{i.ageDays}d</Badge>
                          ) : (
                            `${i.ageDays}d`
                          )}
                        </TableCell>
                        <TableCell>
                          <Amount value={i.unallocated} />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        No unapplied cash.
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

// -------------------------------------------------------------- statements

export function CustomerStatementsPage() {
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const [save, setSave] = React.useState(false);
  const [report, setReport] = React.useState<GeneratedStatement | null>(null);
  const generate = useGenerateStatement();
  const history = useStatementHistory({ customerId: customerId ?? undefined, pageSize: 20 });
  return (
    <>
      <PageHeader
        title="Customer Statements"
        description="Opening balance, invoices, credit notes, receipts, refunds, write-offs and the running balance for a period. Saved statements are kept as issued."
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="w-72 space-y-1.5">
            <Label>Customer</Label>
            <PartyCombobox
              cfg={AR_CONFIG}
              value={customerId}
              onChange={(id) => setCustomerId(id)}
            />
          </div>
          <DateRange from={range.from} to={range.to} onChange={setRange} />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={save} onCheckedChange={(v) => setSave(Boolean(v))} /> Save as issued
            statement
          </label>
          <Button
            disabled={!customerId || generate.isPending}
            onClick={async () => {
              try {
                setReport(
                  await generate.mutateAsync({
                    customerId: customerId!,
                    from: range.from,
                    to: range.to,
                    save,
                  }),
                );
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            <FileText /> Generate
          </Button>
        </CardContent>
      </Card>
      {report ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {report.party.name} - {report.from} to {report.to}
              {report.snapshotNumber ? ` - ${report.snapshotNumber}` : ''}
            </CardTitle>
            <CardDescription>
              {report.party.code}
              {report.party.email ? ` - ${report.party.email}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell
                    colSpan={6}
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Opening balance
                  </TableCell>
                  <TableCell>
                    <Amount value={report.openingBalance} />
                  </TableCell>
                </TableRow>
                {report.lines.map((l) => (
                  <TableRow key={`${l.kind}-${l.documentId}-${l.date}`}>
                    <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{l.documentNumber}</span>
                      <div className="text-[10px] uppercase text-muted-foreground">
                        {titleCase(l.kind)}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {l.description ?? l.reference ?? ''}
                    </TableCell>
                    <TableCell className="text-xs">{l.dueDate ?? ''}</TableCell>
                    <TableCell>
                      <Amount value={l.debit} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.credit} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.balance} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={6}
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Closing balance
                  </TableCell>
                  <TableCell>
                    <Amount value={report.closingBalance} className="font-semibold" />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Issued statements</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Number</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="text-right">Closing</TableHead>
                <TableHead>Generated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data?.items.length ? (
                history.data.items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.documentNumber}</TableCell>
                    <TableCell>{s.customerName}</TableCell>
                    <TableCell>
                      {s.fromDate} to {s.toDate}
                    </TableCell>
                    <TableCell>
                      <Amount value={s.closingBalance} />
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(s.generatedAt)}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    No statements saved yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

// ----------------------------------------------------------------- refunds

export function RefundsPage() {
  const { hasPermission } = useSession();
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [decision, setDecision] = React.useState<{
    r: RefundRequest;
    action: 'approve' | 'reject' | 'cancel';
  } | null>(null);
  const refunds = useRefunds({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as RefundRequest['status']),
  });
  const act = useRefundAction();
  const run = async (r: RefundRequest, action: 'submit' | 'pay') => {
    try {
      await act.mutateAsync({ id: r.id, action, paymentDate: today() });
      toast.success(`${r.documentNumber} ${action === 'pay' ? 'paid' : 'submitted'}.`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const columns = React.useMemo<ColumnDef<RefundRequest>[]>(
    () => [
      {
        id: 'number',
        header: 'Refund',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.documentNumber}</span>,
      },
      {
        id: 'customer',
        header: 'Customer',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-xs">
            <div className="truncate">{row.original.customerName}</div>
            <div className="truncate text-xs text-muted-foreground">{row.original.reason}</div>
          </div>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.paymentNumber ? (
            <Link
              href={`${AR_CONFIG.payment.path}/${row.original.paymentId}`}
              className="font-mono text-xs hover:underline"
            >
              {row.original.paymentNumber}
            </Link>
          ) : (
            (row.original.creditNoteNumber ?? 'Customer credit')
          ),
      },
      {
        id: 'amount',
        header: () => <div className="text-right">Amount</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.amount} currency={row.original.currency} />,
      },
      {
        id: 'paid',
        header: 'Paid by',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.refundPaymentNumber ? (
            <Link
              href={`${AR_CONFIG.payment.path}/${row.original.refundPaymentId}`}
              className="font-mono text-xs hover:underline"
            >
              {row.original.refundPaymentNumber}
            </Link>
          ) : (
            '-'
          ),
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
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex justify-end gap-1">
              {r.status === 'DRAFT' && hasPermission(P['customer-refund.create']) ? (
                <Button size="sm" variant="outline" onClick={() => run(r, 'submit')}>
                  Submit
                </Button>
              ) : null}
              {(r.status === 'DRAFT' || r.status === 'SUBMITTED') &&
              hasPermission(P['customer-refund.approve']) ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDecision({ r, action: 'approve' })}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDecision({ r, action: 'reject' })}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {r.status === 'APPROVED' && hasPermission(P['customer-refund.pay']) ? (
                <Button size="sm" onClick={() => run(r, 'pay')}>
                  Pay
                </Button>
              ) : null}
              {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(r.status) &&
              hasPermission(P['customer-refund.create']) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDecision({ r, action: 'cancel' })}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasPermission],
  );
  return (
    <>
      <PageHeader
        title="Customer Refunds"
        description="Customer credit (overpayments, unapplied receipts, credit notes) returned as money out. Requests are capped by unapplied credit, approved by someone other than the requester, and paying posts Dr AR / Cr cash."
      />
      <DataTable
        columns={columns}
        data={refunds.data}
        isLoading={refunds.isLoading}
        isFetching={refunds.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        emptyState={
          <EmptyState
            title="No refund requests"
            description="Request one from a receipt with unapplied cash."
          />
        }
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Refund, customer, reason"
                className="w-64 pl-8"
              />
            </div>
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
                <SelectItem value="ALL">All statuses</SelectItem>
                {REFUND_REQUEST_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      {decision ? (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDecision(null)}
          title={`${titleCase(decision.action)} ${decision.r.documentNumber}`}
          description={`${decision.r.customerName} - ${decision.r.currency} ${decision.r.amount}`}
          label="Comment"
          required={decision.action !== 'approve'}
          confirmLabel={titleCase(decision.action)}
          destructive={decision.action !== 'approve'}
          loading={act.isPending}
          onConfirm={async (comment) => {
            try {
              await act.mutateAsync({
                id: decision.r.id,
                action: decision.action,
                comment: comment || undefined,
              });
              toast.success('Done.');
              setDecision(null);
            } catch (err) {
              toast.error(describeError(err));
            }
          }}
        />
      ) : null}
    </>
  );
}
