'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, CheckCircle2, Hourglass } from 'lucide-react';
import { toast } from 'sonner';
import { P, REVENUE_RECOGNITION_METHODS, REVENUE_SCHEDULE_STATUSES } from '@accounting/types';
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
  useCompleteMilestone,
  useRevenueSchedule,
  useRevenueSchedules,
} from '@/lib/api/revenue-hooks';
import type { RevenueSchedule, RevenueScheduleLine } from '@/lib/api/revenue-types';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import { Amount, today } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Field, Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';
import { METHOD_LABEL } from './policies';

/** Every deferred invoice line with its remaining balance and the date it next falls due. */
export function RevenueSchedulesPage() {
  const router = useRouter();
  const table = useTableState();
  const [status, setStatus] = React.useState('ACTIVE');
  const [method, setMethod] = React.useState('ALL');
  const schedules = useRevenueSchedules({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as RevenueSchedule['status']),
    method: method === 'ALL' ? undefined : (method as RevenueSchedule['method']),
  });
  const columns = React.useMemo<ColumnDef<RevenueSchedule>[]>(
    () => [
      {
        id: 'description',
        header: 'Schedule',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="text-sm">{row.original.description}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.customerCode} {row.original.customerName} -{' '}
              {formatDate(row.original.documentDate)}
            </div>
          </div>
        ),
      },
      {
        id: 'method',
        header: 'Method',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="text-sm">{METHOD_LABEL[row.original.method]}</div>
            <div className="text-xs text-muted-foreground">{row.original.policyCode}</div>
          </div>
        ),
      },
      {
        id: 'service',
        header: 'Service period',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.serviceStartDate
            ? `${formatDate(row.original.serviceStartDate)} - ${formatDate(row.original.serviceEndDate)}`
            : '-',
      },
      {
        id: 'total',
        header: () => <span className="block text-right">Total</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.totalAmount} currency={row.original.currency} />
        ),
      },
      {
        id: 'recognized',
        header: () => <span className="block text-right">Recognized</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount
            value={row.original.recognizedAmount}
            currency={row.original.currency}
            zeroAsDash
          />
        ),
      },
      {
        id: 'remaining',
        header: () => <span className="block text-right">Deferred</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount
            value={row.original.remainingAmount}
            currency={row.original.currency}
            zeroAsDash
          />
        ),
      },
      {
        id: 'next',
        header: 'Next due',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.nextRecognitionDate ? formatDate(row.original.nextRecognitionDate) : '-',
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
        title="Revenue Schedules"
        description="Deferred revenue by invoice line: what was billed, what has been earned and when the rest falls due. Schedules are created by invoice posting and released only by recognition runs."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/revenue/runs">Recognition runs</Link>
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={schedules.data}
        isLoading={schedules.isLoading}
        isFetching={schedules.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/revenue/schedules/${r.id}`)}
        emptyState={
          <EmptyState
            icon={Hourglass}
            title="No revenue schedules"
            description="Post an invoice whose lines carry a ratable or milestone policy."
          />
        }
        toolbar={
          <div className="flex gap-2">
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-36" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {REVENUE_SCHEDULE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={method}
              onValueChange={(v) => {
                setMethod(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-44" aria-label="Method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All methods</SelectItem>
                {REVENUE_RECOGNITION_METHODS.filter((m) => m !== 'POINT_IN_TIME').map((m) => (
                  <SelectItem key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
    </>
  );
}

// ----------------------------------------------------------------- detail

export function RevenueScheduleDetailPage({ id }: { id: string }) {
  const schedule = useRevenueSchedule(id);
  const [completing, setCompleting] = React.useState<RevenueScheduleLine | null>(null);
  return (
    <QueryState query={schedule}>
      {(s) => (
        <>
          <PageHeader
            eyebrow={
              <Link href="/revenue/schedules" className="inline-flex items-center gap-1 text-xs">
                <ArrowLeft className="h-3 w-3" /> Revenue schedules
              </Link>
            }
            title={s.description}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge status={s.status} /> {METHOD_LABEL[s.method]} ({s.policyCode}) -{' '}
                {s.customerCode} {s.customerName} - invoice{' '}
                <Link href={`/sales/invoices/${s.invoiceId}`} className="underline">
                  {s.documentNumber}
                </Link>
              </span>
            }
          />
          <div className="grid gap-3 sm:grid-cols-4">
            <Kpi label="Billed" value={s.totalAmount} currency={s.currency} />
            <Kpi label="Recognized" value={s.recognizedAmount} currency={s.currency} />
            <Kpi
              label="Deferred"
              value={s.remainingAmount}
              currency={s.currency}
              tone={Number(s.remainingAmount) ? 'warning' : 'success'}
            />
            <Kpi
              label="Accounts"
              value={`${s.deferredAccountCode} -> ${s.revenueAccountCode}`}
              raw
              hint={
                s.serviceStartDate
                  ? `${formatDate(s.serviceStartDate)} to ${formatDate(s.serviceEndDate)}`
                  : 'no service window'
              }
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recognition lines</CardTitle>
              <CardDescription>
                {s.method === 'MILESTONE'
                  ? 'A milestone falls due once it is marked complete; the next run releases it on the completion date.'
                  : 'Each line is released by the first run whose period end covers its date.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>#</TableHead>
                    <TableHead>{s.method === 'MILESTONE' ? 'Milestone' : 'Period'}</TableHead>
                    <TableHead>Recognition date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Run / journal</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.lines.map((l) => (
                    <TableRow key={l.id} data-testid="schedule-line">
                      <TableCell className="font-mono text-xs">{l.sequence}</TableCell>
                      <TableCell>
                        {l.milestoneName ? (
                          <div>
                            <div>{l.milestoneName}</div>
                            <div className="text-xs text-muted-foreground">
                              {Number(l.milestonePercent)}%{' '}
                              {l.completedAt
                                ? `- completed ${formatDateTime(l.completedAt)}`
                                : '- not yet complete'}
                              {l.completionNote ? ` (${l.completionNote})` : ''}
                            </div>
                          </div>
                        ) : (
                          l.recognitionDate?.slice(0, 7)
                        )}
                      </TableCell>
                      <TableCell>
                        {l.recognitionDate ? formatDate(l.recognitionDate) : 'unscheduled'}
                      </TableCell>
                      <TableCell>
                        <Amount value={l.amount} currency={s.currency} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={l.status} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {l.runId ? (
                          <Link href={`/revenue/runs/${l.runId}`} className="underline">
                            {l.runNumber}
                          </Link>
                        ) : (
                          '-'
                        )}
                        {l.journalEntryId ? (
                          <>
                            {' / '}
                            <Link
                              href={`/accounting/journal-entries/${l.journalEntryId}`}
                              className="underline"
                            >
                              {l.journalNumber}
                            </Link>
                          </>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {s.method === 'MILESTONE' &&
                        s.status === 'ACTIVE' &&
                        l.status === 'PENDING' &&
                        !l.completedAt ? (
                          <Can permissions={[P['revenue.manage']]}>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCompleting(l)}
                              data-testid="complete-milestone"
                            >
                              <CheckCircle2 /> Mark complete
                            </Button>
                          </Can>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <CompleteMilestoneDialog
            scheduleId={s.id}
            line={completing}
            onClose={() => setCompleting(null)}
          />
        </>
      )}
    </QueryState>
  );
}

function CompleteMilestoneDialog({
  scheduleId,
  line,
  onClose,
}: {
  scheduleId: string;
  line: RevenueScheduleLine | null;
  onClose: () => void;
}) {
  const complete = useCompleteMilestone();
  const [completedOn, setCompletedOn] = React.useState(today());
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    if (line) {
      setCompletedOn(today());
      setNote('');
    }
  }, [line]);
  return (
    <Dialog open={Boolean(line)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete milestone {line?.milestoneName}</DialogTitle>
          <DialogDescription>
            The milestone becomes due on the completion date and the next recognition run covering
            that date releases {line?.amount}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Completed on">
            <Input
              type="date"
              value={completedOn}
              onChange={(e) => setCompletedOn(e.target.value)}
              data-testid="milestone-date"
            />
          </Field>
          <Field label="Note">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={complete.isPending}>
            Cancel
          </Button>
          <Button
            disabled={complete.isPending || !line}
            data-testid="milestone-confirm"
            onClick={async () => {
              if (!line) return;
              try {
                await complete.mutateAsync({
                  scheduleId,
                  lineId: line.id,
                  completedOn,
                  note: note || undefined,
                });
                toast.success(`Milestone ${line.milestoneName} completed`);
                onClose();
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Mark complete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
