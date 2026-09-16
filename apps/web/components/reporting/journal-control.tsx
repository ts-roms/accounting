'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { Search } from 'lucide-react';
import { JOURNAL_STATUSES, type JournalStatus } from '@accounting/types';
import {
  Badge,
  Card,
  CardContent,
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
import { useJournalEntries } from '@/lib/api/accounting-hooks';
import { useBranches, useUsers } from '@/lib/api/hooks';
import { useJournalControlSummary } from '@/lib/api/reporting-engine-hooks';
import type { JournalEntryView } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { EmptyState, MetricSkeleton, PageHeader } from '@/components/ui-ext/page';
import {
  Amount,
  DateRange,
  JournalStatusBadge,
  startOfMonth,
  today,
} from '@/components/accounting/primitives';

const ALL = 'ALL';

/**
 * Journal control center: one place to review the journal population by
 * source module, actor and amount, with the review indicators controllers
 * look for (manual journals, self-posted entries, reversals, entries waiting
 * for approval). Figures are counts over journal_entries; the ledger is
 * never re-totalled here.
 */
export function JournalControlPage() {
  const router = useRouter();
  const { activeCompany } = useSession();
  const table = useTableState({ sortBy: 'entryDate', sortDir: 'desc' });
  const [range, setRange] = React.useState({ from: startOfMonth(), to: today() });
  const [status, setStatus] = React.useState(ALL);
  const [sourceType, setSourceType] = React.useState(ALL);
  const [branchId, setBranchId] = React.useState(ALL);
  const [createdBy, setCreatedBy] = React.useState(ALL);
  const [postedBy, setPostedBy] = React.useState(ALL);
  const [minAmount, setMinAmount] = React.useState('');
  const [maxAmount, setMaxAmount] = React.useState('');

  const filters = React.useMemo(
    () => ({
      from: range.from || undefined,
      to: range.to || undefined,
      status: status === ALL ? undefined : (status as JournalStatus),
      sourceType: sourceType === ALL ? undefined : sourceType,
      branchId: branchId === ALL ? undefined : branchId,
      createdBy: createdBy === ALL ? undefined : createdBy,
      postedBy: postedBy === ALL ? undefined : postedBy,
      minAmount: /^\d+(\.\d+)?$/.test(minAmount) ? minAmount : undefined,
      maxAmount: /^\d+(\.\d+)?$/.test(maxAmount) ? maxAmount : undefined,
    }),
    [range, status, sourceType, branchId, createdBy, postedBy, minAmount, maxAmount],
  );
  const summary = useJournalControlSummary({ ...filters, search: table.search || undefined });
  const entries = useJournalEntries({ ...table.query, ...filters });
  const branches = useBranches(activeCompany?.id);
  const users = useUsers({ pageSize: 100 });
  const set =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      table.resetPage();
    };

  const columns = React.useMemo<ColumnDef<JournalEntryView>[]>(
    () => [
      {
        accessorKey: 'entryDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.entryDate}</span>,
      },
      {
        accessorKey: 'documentNumber',
        header: 'Number',
        cell: ({ row }) => (
          <Link
            href={`/accounting/journal-entries/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.documentNumber}
          </Link>
        ),
      },
      {
        id: 'description',
        header: 'Description',
        enableSorting: false,
        cell: ({ row }) => <div className="max-w-md truncate">{row.original.description}</div>,
      },
      {
        id: 'source',
        header: 'Source',
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.sourceType ? 'outline' : 'secondary'}>
            {row.original.sourceType ? titleCase(row.original.sourceType) : 'Manual'}
          </Badge>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs">{titleCase(row.original.journalType)}</span>,
      },
      {
        accessorKey: 'totalDebit',
        header: () => <div className="text-right">Amount</div>,
        cell: ({ row }) => (
          <Amount value={row.original.totalDebit} currency={row.original.currency} />
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <JournalStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );

  const total = summary.data?.total;
  const metric = (label: string, value: React.ReactNode, testId: string, hint?: string) => (
    <Card>
      <CardContent className="p-4">
        <div className="type-label text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular" data-testid={testId}>
          {value}
        </div>
        {hint ? <div className="type-label text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Journal Control Center"
        description="Review the journal population by source module, preparer, poster and amount. Manual journals, self-posted entries and reversals are the usual review targets; open any entry to trace it to its source document and audit trail."
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <DateRange from={range.from} to={range.to} onChange={set(setRange)} />
          <Select value={sourceType} onValueChange={set(setSourceType)}>
            <SelectTrigger className="w-48" data-testid="jc-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              <SelectItem value="MANUAL">Manual journals</SelectItem>
              {(summary.data?.bySource ?? [])
                .filter((s) => s.sourceType !== 'MANUAL')
                .map((s) => (
                  <SelectItem key={s.sourceType} value={s.sourceType}>
                    {titleCase(s.sourceType)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={set(setStatus)}>
            <SelectTrigger className="w-36" data-testid="jc-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {JOURNAL_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={branchId} onValueChange={set(setBranchId)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All branches</SelectItem>
              {(branches.data ?? []).map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.code} {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={createdBy} onValueChange={set(setCreatedBy)}>
            <SelectTrigger className="w-48" data-testid="jc-created-by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any preparer</SelectItem>
              {(users.data?.items ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={postedBy} onValueChange={set(setPostedBy)}>
            <SelectTrigger className="w-48" data-testid="jc-posted-by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any poster</SelectItem>
              {(users.data?.items ?? []).map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.firstName} {u.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            inputMode="decimal"
            placeholder="Min amount"
            className="w-32"
            value={minAmount}
            onChange={(e) => set(setMinAmount)(e.target.value)}
            data-testid="jc-min"
          />
          <Input
            inputMode="decimal"
            placeholder="Max amount"
            className="w-32"
            value={maxAmount}
            onChange={(e) => set(setMaxAmount)(e.target.value)}
            data-testid="jc-max"
          />
        </CardContent>
      </Card>
      {summary.isLoading || !total ? (
        <MetricSkeleton />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {metric('Entries', total.count, 'jc-count')}
          {metric(
            'Total debit',
            <Amount value={total.totalDebit} className="text-left" />,
            'jc-total',
          )}
          {metric('Manual', total.manual, 'jc-manual', 'no source document')}
          {metric('Awaiting approval', total.awaitingApproval, 'jc-awaiting')}
          {metric('Self-posted', total.selfPosted, 'jc-self-posted', 'preparer = poster')}
          {metric(
            'Reversals',
            `${total.reversals} / ${total.reversed}`,
            'jc-reversals',
            'reversing / reversed',
          )}
        </div>
      )}
      {summary.data ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardContent className="p-0">
              <Table data-testid="jc-by-source">
                <TableHeader>
                  <TableRow>
                    <TableHead>Source module</TableHead>
                    <TableHead className="text-right">Entries</TableHead>
                    <TableHead className="text-right">Posted</TableHead>
                    <TableHead className="text-right">Total debit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.data.bySource.map((s) => (
                    <TableRow
                      key={s.sourceType}
                      className="cursor-pointer"
                      onClick={() => set(setSourceType)(s.sourceType)}
                    >
                      <TableCell>
                        {s.sourceType === 'MANUAL' ? 'Manual' : titleCase(s.sourceType)}
                      </TableCell>
                      <TableCell className="text-right tabular">{s.count}</TableCell>
                      <TableCell className="text-right tabular">{s.posted}</TableCell>
                      <TableCell>
                        <Amount value={s.totalDebit} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              <Table data-testid="jc-by-status">
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Entries</TableHead>
                    <TableHead className="text-right">Total debit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.data.byStatus.map((s) => (
                    <TableRow
                      key={s.status}
                      className="cursor-pointer"
                      onClick={() => set(setStatus)(s.status)}
                    >
                      <TableCell>
                        <JournalStatusBadge status={s.status as JournalStatus} />
                      </TableCell>
                      <TableCell className="text-right tabular">{s.count}</TableCell>
                      <TableCell>
                        <Amount value={s.totalDebit} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      ) : null}
      <DataTable
        columns={columns}
        data={entries.data}
        isLoading={entries.isLoading}
        error={entries.error}
        onRetry={() => void entries.refetch()}
        isFetching={entries.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(e) => e.id}
        onRowClick={(e) => router.push(`/accounting/journal-entries/${e.id}`)}
        toolbar={
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={table.search}
              onChange={(e) => table.setSearch(e.target.value)}
              placeholder="Number, description, reference"
              className="w-64 pl-8"
            />
          </div>
        }
        emptyState={
          <EmptyState
            className="border-0"
            title="No journal entries"
            description="Nothing matches the filters."
          />
        }
      />
    </>
  );
}
