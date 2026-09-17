'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import { ORDER_STATUSES, type OrderStatus } from '@accounting/types';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { useOrders } from '@/lib/api/orders-hooks';
import type { Order } from '@/lib/api/types';
import type { OrderConfig } from '@/lib/orders/config';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { FulfillmentBadge, OrderStatusBadge } from './badges';

const DESCRIPTION: Record<OrderConfig['type'], string> = {
  QUOTATION:
    'Priced offers to customers. Accepted quotations convert into sales orders; nothing is posted.',
  SALES_ORDER:
    'Confirmed customer orders. Approve, then invoice the delivered quantities - the invoice carries the ledger effect.',
  PURCHASE_REQUEST:
    'Internal requests for goods or services. Approved requests convert into purchase orders.',
  PURCHASE_ORDER:
    'Commitments to vendors. Receive goods, then bill against the order - bills are three-way matched.',
};

export function OrdersPage({ cfg }: { cfg: OrderConfig }) {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'orderDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const orders = useOrders(cfg, {
    ...table.query,
    status: status === 'ALL' ? undefined : (status as OrderStatus),
  });
  const statuses = ORDER_STATUSES.filter(
    (s) =>
      cfg.actions.some((a) => a.from.includes(s)) ||
      ['DRAFT', 'APPROVED', 'CONVERTED', 'CLOSED', 'CANCELLED', 'REJECTED'].includes(s),
  );

  const columns = React.useMemo<ColumnDef<Order>[]>(
    () => [
      {
        accessorKey: 'orderDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.orderDate}</span>,
      },
      {
        accessorKey: 'documentNumber',
        header: 'Number',
        cell: ({ row }) => (
          <Link
            href={`${cfg.path}/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.documentNumber}
          </Link>
        ),
      },
      {
        id: 'party',
        header: cfg.subledger.party.singular,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-xs">
            <div className="truncate">
              {row.original.partyName ?? (
                <span className="text-muted-foreground">Not assigned</span>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.reference ?? row.original.description ?? ''}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'expectedDate',
        header: cfg.expectedDateLabel,
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.expectedDate ?? '-'}</span>
        ),
      },
      {
        accessorKey: 'total',
        header: () => <div className="text-right">Total</div>,
        cell: ({ row }) => <Amount value={row.original.total} currency={row.original.currency} />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1">
            <OrderStatusBadge status={row.original.status} />
            {cfg.tracksReceipts && row.original.status !== 'DRAFT' ? (
              <FulfillmentBadge status={row.original.receiptStatus} label="Received" />
            ) : null}
            {cfg.tracksBilling && row.original.status !== 'DRAFT' ? (
              <FulfillmentBadge
                status={row.original.billingStatus}
                label={cfg.type === 'SALES_ORDER' ? 'Invoiced' : 'Billed'}
              />
            ) : null}
          </div>
        ),
      },
    ],
    [cfg],
  );

  return (
    <>
      <PageHeader
        title={cfg.plural}
        description={DESCRIPTION[cfg.type]}
        actions={
          <Can permissions={[cfg.permissions.create]}>
            <Button asChild>
              <Link href={`${cfg.path}/new`}>
                <Plus /> New {cfg.singular.toLowerCase()}
              </Link>
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={orders.data}
        isLoading={orders.isLoading}
        isFetching={orders.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(o) => o.id}
        onRowClick={(o) => router.push(`${cfg.path}/${o.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder={`Number, reference, ${cfg.subledger.party.singular.toLowerCase()}`}
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
                {statuses.map((s) => (
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
            title={`No ${cfg.plural.toLowerCase()}`}
            description="Nothing matches the filters."
          />
        }
      />
    </>
  );
}
