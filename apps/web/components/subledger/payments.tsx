'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import { PAYMENT_STATUSES, type PaymentStatus } from '@accounting/types';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { usePayments } from '@/lib/api/subledger-hooks';
import type { SubledgerPayment } from '@/lib/api/types';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { PaymentStatusBadge } from './badges';
import { partyOf } from './documents';

export function PaymentsPage({ cfg }: { cfg: SubledgerConfig }) {
  const router = useRouter();
  const table = useTableState({ sortBy: 'paymentDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const payments = usePayments(cfg, {
    ...table.query,
    status: status === 'ALL' ? undefined : (status as PaymentStatus),
  });

  const columns = React.useMemo<ColumnDef<SubledgerPayment>[]>(
    () => [
      {
        accessorKey: 'paymentDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.paymentDate}</span>,
      },
      {
        accessorKey: 'documentNumber',
        header: 'Number',
        cell: ({ row }) => (
          <div>
            <Link
              href={`${cfg.payment.path}/${row.original.id}`}
              className="font-mono text-xs font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.documentNumber}
            </Link>
            {row.original.paymentType === 'REFUND' ? (
              <div className="text-[10px] uppercase text-muted-foreground">Refund</div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'party',
        header: cfg.party.singular,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-xs">
            <div className="truncate">{partyOf(cfg, row.original).name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.reference ?? ''}
            </div>
          </div>
        ),
      },
      {
        id: 'method',
        header: 'Method',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.method),
      },
      {
        id: 'cash',
        header: 'Cash account',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            <span className="font-mono text-muted-foreground">{row.original.cashAccountCode}</span>{' '}
            {row.original.cashAccountName}
          </span>
        ),
      },
      {
        accessorKey: 'amount',
        header: () => <div className="text-right">Amount</div>,
        cell: ({ row }) => <Amount value={row.original.amount} currency={row.original.currency} />,
      },
      {
        id: 'unallocated',
        header: () => <div className="text-right">On account</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount
            value={row.original.unallocatedAmount}
            currency={row.original.currency}
            zeroAsDash
          />
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <PaymentStatusBadge status={row.original.status} />,
      },
    ],
    [cfg],
  );

  return (
    <>
      <PageHeader
        title={cfg.payment.plural}
        description={
          cfg.side === 'AR'
            ? 'Money received from customers. Posting a receipt debits cash and credits receivables; allocations settle invoices.'
            : 'Money paid to vendors. Posting a payment debits payables and credits cash; allocations settle bills.'
        }
        actions={
          <Can permissions={[cfg.permissions.payCreate]}>
            <Button asChild>
              <Link href={`${cfg.payment.path}/new`}>
                <Plus /> New {cfg.payment.singular.toLowerCase()}
              </Link>
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={payments.data}
        isLoading={payments.isLoading}
        error={payments.error}
        onRetry={() => void payments.refetch()}
        isFetching={payments.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(p) => p.id}
        onRowClick={(p) => router.push(`${cfg.payment.path}/${p.id}`)}
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
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {PAYMENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
        emptyState={
          <EmptyState
            className="border-0"
            title={`No ${cfg.payment.plural.toLowerCase()}`}
            description="Nothing matches the filters."
          />
        }
      />
    </>
  );
}
