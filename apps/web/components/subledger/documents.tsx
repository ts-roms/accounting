'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import {
  SUBLEDGER_DOCUMENT_STATUSES,
  SUBLEDGER_DOCUMENT_TYPES,
  type SubledgerDocumentStatus,
  type SubledgerDocumentType,
} from '@accounting/types';
import {
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { useDocuments } from '@/lib/api/subledger-hooks';
import type { SubledgerDocument } from '@/lib/api/types';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { DocumentStatusBadge } from './badges';

export function partyOf(
  cfg: SubledgerConfig,
  d: {
    customerCode?: string;
    customerName?: string;
    vendorCode?: string;
    vendorName?: string;
    customerId?: string;
    vendorId?: string;
  },
) {
  return cfg.side === 'AR'
    ? { id: d.customerId, code: d.customerCode, name: d.customerName }
    : { id: d.vendorId, code: d.vendorCode, name: d.vendorName };
}

export function DocumentsPage({
  cfg,
  initialStatus,
  initialType,
}: {
  cfg: SubledgerConfig;
  initialStatus?: string;
  initialType?: SubledgerDocumentType;
}) {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'documentDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState(initialStatus ?? 'ALL');
  const [type, setType] = React.useState<string>(initialType ?? 'ALL');
  const [openOnly, setOpenOnly] = React.useState(false);
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const documents = useDocuments(cfg, {
    ...table.query,
    status: status === 'ALL' ? undefined : (status as SubledgerDocumentStatus),
    documentType: type === 'ALL' ? undefined : (type as SubledgerDocumentType),
    openOnly: openOnly || undefined,
    overdueOnly: overdueOnly || undefined,
  });

  const columns = React.useMemo<ColumnDef<SubledgerDocument>[]>(
    () => [
      {
        accessorKey: 'documentDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.documentDate}</span>,
      },
      {
        accessorKey: 'documentNumber',
        header: 'Number',
        cell: ({ row }) => (
          <div>
            <Link
              href={`${cfg.document.path}/${row.original.id}`}
              className="font-mono text-xs font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.documentNumber}
            </Link>
            {row.original.documentType !== 'INVOICE' ? (
              <div className="text-[10px] uppercase text-muted-foreground">
                {titleCase(row.original.documentType)}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'party',
        header: cfg.party.singular,
        enableSorting: false,
        cell: ({ row }) => {
          const p = partyOf(cfg, row.original);
          return (
            <div className="max-w-xs">
              <div className="truncate">{p.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {row.original.reference ?? row.original.vendorInvoiceNumber ?? ''}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'dueDate',
        header: 'Due',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {row.original.dueDate}
            {row.original.daysOverdue > 0 ? (
              <span className="ml-1 text-xs text-critical">+{row.original.daysOverdue}d</span>
            ) : null}
          </span>
        ),
      },
      {
        accessorKey: 'total',
        header: () => <div className="text-right">Total</div>,
        cell: ({ row }) => <Amount value={row.original.total} currency={row.original.currency} />,
      },
      {
        id: 'balance',
        header: () => <div className="text-right">Balance</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.balance} currency={row.original.currency} zeroAsDash />
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <DocumentStatusBadge
            status={row.original.status}
            accountingStatus={row.original.accountingStatus}
          />
        ),
      },
    ],
    [cfg],
  );

  return (
    <>
      <PageHeader
        title={cfg.document.plural}
        description={
          cfg.side === 'AR'
            ? 'Invoices, credit notes and debit notes. Posting creates the receivable in the ledger; receipts settle it.'
            : 'Supplier bills, credit notes and debit notes. Posting creates the payable in the ledger; payments settle it.'
        }
        actions={
          <Can permissions={[cfg.permissions.docCreate]}>
            <Button asChild>
              <Link href={`${cfg.document.path}/new`}>
                <Plus /> New {cfg.document.singular.toLowerCase()}
              </Link>
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={documents.data}
        isLoading={documents.isLoading}
        error={documents.error}
        onRetry={() => void documents.refetch()}
        isFetching={documents.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(d) => d.id}
        onRowClick={(d) => router.push(`${cfg.document.path}/${d.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder={`Number, reference, ${cfg.party.singular.toLowerCase()}`}
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
                {SUBLEDGER_DOCUMENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All types</SelectItem>
                {SUBLEDGER_DOCUMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === 'INVOICE' ? cfg.document.singular : titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Checkbox
                id="open-only"
                checked={openOnly}
                onCheckedChange={(v) => {
                  setOpenOnly(v === true);
                  table.resetPage();
                }}
              />
              <Label htmlFor="open-only" className="font-normal">
                Open
              </Label>
              <Checkbox
                id="overdue-only"
                checked={overdueOnly}
                onCheckedChange={(v) => {
                  setOverdueOnly(v === true);
                  table.resetPage();
                }}
              />
              <Label htmlFor="overdue-only" className="font-normal">
                Overdue
              </Label>
            </div>
          </>
        }
        emptyState={
          <EmptyState
            className="border-0"
            title={`No ${cfg.document.plural.toLowerCase()}`}
            description="Nothing matches the filters."
          />
        }
      />
    </>
  );
}
