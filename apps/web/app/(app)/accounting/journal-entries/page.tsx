'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import {
  JOURNAL_STATUSES,
  JOURNAL_TYPES,
  P,
  type JournalStatus,
  type JournalType,
} from '@accounting/types';
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { useJournalEntries } from '@/lib/api/accounting-hooks';
import type { JournalEntryView } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { ExportButton } from '@/components/data-infrastructure/export-button';
import {
  Amount,
  DateRange,
  JournalStatusBadge,
  startOfYear,
  today,
} from '@/components/accounting/primitives';

export default function JournalEntriesPage() {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'entryDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [journalType, setJournalType] = React.useState('ALL');
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });

  const entries = useJournalEntries({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as JournalStatus),
    journalType: journalType === 'ALL' ? undefined : (journalType as JournalType),
    from: range.from || undefined,
    to: range.to || undefined,
  });

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
        cell: ({ row }) => (
          <div className="max-w-md">
            <div className="truncate">{row.original.description}</div>
            {row.original.reference ? (
              <div className="truncate text-xs text-muted-foreground">
                Ref: {row.original.reference}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        enableSorting: false,
        cell: ({ row }) => <Badge variant="outline">{titleCase(row.original.journalType)}</Badge>,
      },
      {
        id: 'period',
        header: 'Period',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs">{row.original.periodName}</span>
        ),
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

  return (
    <>
      <PageHeader
        title="Journal Entries"
        description="Every ledger movement is a balanced journal entry. Drafts are submitted, approved and posted; posted entries are only ever reversed."
        actions={
          <div className="flex items-center gap-2">
            <ExportButton
              dataset="JOURNAL_ENTRIES"
              query={{ from: range.from || undefined, to: range.to || undefined }}
            />
            <Can permissions={[P['journal.create']]}>
              <Button asChild>
                <Link href="/accounting/journal-entries/new">
                  <Plus /> New entry
                </Link>
              </Button>
            </Can>
          </div>
        }
      />
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
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Number, description, reference"
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
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {JOURNAL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={journalType}
              onValueChange={(v) => {
                setJournalType(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All types</SelectItem>
                {JOURNAL_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DateRange
              from={range.from}
              to={range.to}
              onChange={(r) => {
                setRange(r);
                table.resetPage();
              }}
            />
          </>
        }
        emptyState={
          <EmptyState
            className="border-0"
            title="No journal entries"
            description="Nothing matches the filters, or no entries exist yet."
          />
        }
      />
    </>
  );
}
