'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, CalendarCheck, PlayCircle, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@accounting/money';
import { P, REVENUE_RUN_STATUSES } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateRevenueRun,
  useReverseRevenueRun,
  useRevenueRun,
  useRevenueRunPreview,
  useRevenueRuns,
} from '@/lib/api/revenue-hooks';
import type { RevenueRun } from '@/lib/api/revenue-types';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import { OperationDialog, POSTING_STEPS } from '@/components/accounting/operation-dialog';
import { Amount, today } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Field, Kpi, ReasonDialog, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';

/** Last day of the month containing `iso`. */
function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function RevenueRunsPage() {
  const router = useAppRouter();
  const table = useTableState();
  const [status, setStatus] = React.useState('ALL');
  const [periodEnd, setPeriodEnd] = React.useState(endOfMonth(today()));
  const [description, setDescription] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const runs = useRevenueRuns({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as RevenueRun['status']),
  });
  const preview = useRevenueRunPreview(periodEnd);
  const create = useCreateRevenueRun();
  const columns = React.useMemo<ColumnDef<RevenueRun>[]>(
    () => [
      {
        id: 'number',
        header: 'Run',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-mono text-sm">{row.original.documentNumber}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.description ?? '-'}
            </div>
          </div>
        ),
      },
      {
        id: 'period',
        header: 'Period end',
        enableSorting: false,
        cell: ({ row }) => formatDate(row.original.periodEnd),
      },
      {
        id: 'lines',
        header: 'Lines',
        enableSorting: false,
        cell: ({ row }) => row.original.lineCount,
      },
      {
        id: 'amount',
        header: () => <span className="block text-right">Recognized</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.totalAmount} currency={row.original.currency} />
        ),
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
        id: 'by',
        header: 'Posted by',
        enableSorting: false,
        cell: ({ row }) => row.original.createdByName ?? 'Scheduler',
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
  const p = preview.data;
  return (
    <>
      <PageHeader
        title="Recognition Runs"
        description="A run posts one adjusting journal (Dr deferred revenue / Cr revenue) for every schedule line due up to the period end. Reverse latest first when a period needs re-running."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/revenue/reports">Deferred revenue reports</Link>
          </Button>
        }
      />
      <Can permissions={[P['revenue.recognize']]}>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recognize up to a period end</CardTitle>
            <CardDescription>
              Ratable lines dated on or before the period end and milestones already marked
              complete.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
            <Field label="Period end">
              <Input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                data-testid="run-period-end"
              />
            </Field>
            <Field label="Description">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Month-end recognition"
              />
            </Field>
            <Button
              onClick={() => setConfirming(true)}
              disabled={!p || p.lines === 0}
              data-testid="run-recognize"
            >
              <PlayCircle /> Recognize{' '}
              {p ? `${p.lines} line(s) - ${formatMoney(p.amount, p.currency)}` : '...'}
            </Button>
          </CardContent>
        </Card>
      </Can>
      <DataTable
        columns={columns}
        data={runs.data}
        isLoading={runs.isLoading}
        isFetching={runs.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/revenue/runs/${r.id}`)}
        emptyState={
          <EmptyState
            icon={CalendarCheck}
            title="No recognition runs"
            description="Nothing has been released from deferred revenue yet."
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
              {REVENUE_RUN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <OperationDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Recognize revenue up to ${formatDate(periodEnd)}`}
        description={
          p
            ? `${p.lines} schedule line(s) across ${p.schedules} schedule(s): ${formatMoney(p.amount, p.currency)} moves from deferred revenue to revenue in one journal dated ${formatDate(periodEnd)}.`
            : undefined
        }
        confirmLabel="Post recognition"
        loadingLabel="Posting"
        resultLabel="POSTED"
        steps={POSTING_STEPS}
        run={async () => {
          const result = await create.mutateAsync({
            periodEnd,
            description: description || undefined,
          });
          if ('run' in result && result.run === null) throw new Error(result.message);
          return result;
        }}
        onDone={() => {
          setDescription('');
          toast.success('Recognition run posted');
        }}
      />
    </>
  );
}

// ----------------------------------------------------------------- detail

export function RevenueRunDetailPage({ id }: { id: string }) {
  const run = useRevenueRun(id);
  const reverse = useReverseRevenueRun();
  const [reversing, setReversing] = React.useState(false);
  return (
    <QueryState query={run}>
      {(r) => (
        <>
          <PageHeader
            eyebrow={
              <Link href="/revenue/runs" className="inline-flex items-center gap-1 text-xs">
                <ArrowLeft className="h-3 w-3" /> Recognition runs
              </Link>
            }
            title={r.documentNumber}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge status={r.status} /> period end {formatDate(r.periodEnd)} -{' '}
                {r.description ?? 'no description'} - {r.createdByName ?? 'scheduler'} on{' '}
                {formatDateTime(r.createdAt)}
              </span>
            }
            actions={
              r.status === 'POSTED' ? (
                <Can permissions={[P['revenue.recognize']]}>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setReversing(true)}
                    data-testid="run-reverse"
                  >
                    <Undo2 /> Reverse run
                  </Button>
                </Can>
              ) : null
            }
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label="Recognized" value={r.totalAmount} currency={r.currency} />
            <Kpi label="Lines" value={r.lineCount} />
            <Kpi
              label="Journal"
              value={r.journalNumber ?? '-'}
              raw
              hint={
                r.status === 'REVERSED' ? (
                  `reversed by ${r.reversalJournalNumber} - ${r.reversalReason}`
                ) : r.journalEntryId ? (
                  <Link
                    href={`/accounting/journal-entries/${r.journalEntryId}`}
                    className="underline"
                  >
                    open journal
                  </Link>
                ) : undefined
              }
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Schedule lines in this run</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Schedule</TableHead>
                    <TableHead>Line</TableHead>
                    <TableHead>Recognition date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.lines.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                        {r.status === 'REVERSED'
                          ? 'The lines went back to pending when the run was reversed.'
                          : 'No lines.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    r.lines.map((l) => (
                      <TableRow key={l.lineId}>
                        <TableCell>
                          <Link href={`/revenue/schedules/${l.scheduleId}`} className="underline">
                            {l.scheduleDescription}
                          </Link>
                        </TableCell>
                        <TableCell>{l.milestoneName ?? `#${l.sequence}`}</TableCell>
                        <TableCell>
                          {l.recognitionDate ? formatDate(l.recognitionDate) : '-'}
                        </TableCell>
                        <TableCell>
                          <Amount value={l.amount} currency={r.currency} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <ReasonDialog
            open={reversing}
            onOpenChange={setReversing}
            title={`Reverse ${r.documentNumber}`}
            description="Posts a mirror journal dated on the period end and returns every line to pending. Later runs must be reversed first."
            confirmLabel="Reverse run"
            destructive
            loading={reverse.isPending}
            onConfirm={async (reason) => {
              try {
                await reverse.mutateAsync({ id: r.id, reason });
                toast.success('Run reversed');
                setReversing(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          />
        </>
      )}
    </QueryState>
  );
}
