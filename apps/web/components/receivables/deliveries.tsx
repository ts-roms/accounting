'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Plus, Search, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { DELIVERY_STATUSES, P } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
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
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateDelivery,
  useDeliveries,
  useDelivery,
  useDeliveryAction,
  useInvoiceDelivery,
} from '@/lib/api/receivables-hooks';
import type { Delivery } from '@/lib/api/receivables-types';
import { useOrders } from '@/lib/api/orders-hooks';
import { SALES_ORDER_CONFIG } from '@/lib/orders/config';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { DescriptionList, Field, ReasonDialog, StatusBadge } from './shared';

export function DeliveriesPage() {
  const router = useRouter();
  const table = useTableState({ sortBy: 'deliveryDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [create, setCreate] = React.useState(false);
  const deliveries = useDeliveries({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as Delivery['status']),
  });

  const columns = React.useMemo<ColumnDef<Delivery>[]>(
    () => [
      {
        accessorKey: 'deliveryDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.deliveryDate}</span>,
      },
      {
        accessorKey: 'documentNumber',
        header: 'Number',
        cell: ({ row }) => (
          <Link
            href={`/receivables/deliveries/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.documentNumber}
          </Link>
        ),
      },
      {
        id: 'customer',
        header: 'Customer',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-xs">
            <div className="truncate">{row.original.customerName}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.salesOrderNumber}
            </div>
          </div>
        ),
      },
      {
        id: 'invoices',
        header: 'Invoices',
        enableSorting: false,
        cell: ({ row }) => row.original.invoiceCount || '-',
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
        title="Deliveries"
        description="Goods leave against confirmed sales orders; delivering issues stock and posts the cost of goods. Invoices follow the delivery."
        actions={
          <Can permissions={[P['delivery.manage']]}>
            <Button onClick={() => setCreate(true)}>
              <Plus /> New delivery
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={deliveries.data}
        isLoading={deliveries.isLoading}
        isFetching={deliveries.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(d) => d.id}
        onRowClick={(d) => router.push(`/receivables/deliveries/${d.id}`)}
        emptyState={
          <EmptyState
            icon={Truck}
            title="No deliveries"
            description="Create a delivery from an approved sales order."
          />
        }
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Number, order, customer"
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
                {DELIVERY_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <NewDeliveryDialog
        open={create}
        onOpenChange={setCreate}
        onCreated={(id) => router.push(`/receivables/deliveries/${id}`)}
      />
    </>
  );
}

function NewDeliveryDialog({
  open,
  onOpenChange,
  onCreated,
  salesOrderId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
  salesOrderId?: string;
}) {
  const orders = useOrders(
    SALES_ORDER_CONFIG,
    { openOnly: true, pageSize: 100, sortBy: 'orderDate', sortDir: 'desc' },
    open,
  );
  const create = useCreateDelivery();
  const [orderId, setOrderId] = React.useState(salesOrderId ?? '');
  const [date, setDate] = React.useState(today());
  const [reference, setReference] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New delivery</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field
            label="Sales order"
            hint="Everything still undelivered on the order is picked; edit the lines afterwards if needed."
          >
            <Select value={orderId} onValueChange={setOrderId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an approved / confirmed order" />
              </SelectTrigger>
              <SelectContent>
                {orders.data?.items.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.documentNumber} - {o.partyName} ({o.status.toLowerCase()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Delivery date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reference">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Waybill, DR number..."
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!orderId || create.isPending}
            onClick={async () => {
              try {
                const d = await create.mutateAsync({
                  salesOrderId: orderId,
                  deliveryDate: date,
                  reference: reference || undefined,
                });
                toast.success(`${d.documentNumber} created.`);
                onOpenChange(false);
                onCreated(d.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { NewDeliveryDialog };

export function DeliveryDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { hasPermission } = useSession();
  const delivery = useDelivery(id);
  const action = useDeliveryAction();
  const invoice = useInvoiceDelivery();
  const [cancel, setCancel] = React.useState(false);
  if (!delivery.data) return <Skeleton className="h-96" />;
  const d = delivery.data;
  const run = async (a: 'pick' | 'ready' | 'deliver') => {
    try {
      await action.mutateAsync({ id, action: a });
      toast.success(
        `${d.documentNumber} ${a === 'deliver' ? 'delivered' : a === 'pick' ? 'picking' : 'ready'}.`,
      );
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const canManage = hasPermission(P['delivery.manage']);
  const open = d.status !== 'DELIVERED' && d.status !== 'CANCELLED';
  const toInvoice = d.lines.some((l) => Number(l.remainingToInvoice) > 0);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {d.documentNumber} <StatusBadge status={d.status} />
          </span>
        }
        description={`${d.customerName} - ${d.salesOrderNumber} - ${d.deliveryDate}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/receivables/deliveries">
                <ArrowLeft /> All deliveries
              </Link>
            </Button>
            {canManage && d.status === 'DRAFT' ? (
              <Button variant="outline" size="sm" onClick={() => run('pick')}>
                Start picking
              </Button>
            ) : null}
            {canManage && (d.status === 'DRAFT' || d.status === 'PICKING') ? (
              <Button variant="outline" size="sm" onClick={() => run('ready')}>
                Mark ready
              </Button>
            ) : null}
            {canManage && open ? (
              <Button size="sm" onClick={() => run('deliver')} disabled={action.isPending}>
                Deliver
              </Button>
            ) : null}
            {hasPermission(P['invoice.create']) && d.status === 'DELIVERED' && toInvoice ? (
              <Button
                size="sm"
                disabled={invoice.isPending}
                onClick={async () => {
                  try {
                    const inv = await invoice.mutateAsync(id);
                    toast.success(`Draft ${inv.documentNumber} created.`);
                    router.push(`/sales/invoices/${inv.id}`);
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                Invoice delivery
              </Button>
            ) : null}
            {canManage && d.status !== 'CANCELLED' ? (
              <Button variant="ghost" size="sm" onClick={() => setCancel(true)}>
                Cancel
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>#</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Delivered</TableHead>
                  <TableHead className="text-right">Invoiced</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>{l.lineNumber}</TableCell>
                    <TableCell>
                      {l.description}
                      {l.productSku ? (
                        <div className="font-mono text-xs text-muted-foreground">
                          {l.productSku}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Amount value={l.orderedQuantity} />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.quantity} />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.invoicedQuantity} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.costAmount ?? '0'} zeroAsDash />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              items={[
                [
                  'Customer',
                  <Link
                    key="c"
                    href={`/sales/customers/${d.customerId}`}
                    className="hover:underline"
                  >
                    {d.customerName}
                  </Link>,
                ],
                [
                  'Sales order',
                  <Link
                    key="o"
                    href={`/sales/orders/${d.salesOrderId}`}
                    className="font-mono text-xs hover:underline"
                  >
                    {d.salesOrderNumber}
                  </Link>,
                ],
                ['Reference', d.reference],
                ['Delivered at', d.deliveredAt ? new Date(d.deliveredAt).toLocaleString() : '-'],
                [
                  'COGS journal',
                  d.journalNumber ? (
                    <Link
                      key="j"
                      href={`/accounting/journal-entries/${d.journalEntryId}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {d.journalNumber}
                    </Link>
                  ) : (
                    'none (no stocked lines)'
                  ),
                ],
                ['Invoices', String(d.invoiceCount)],
                ['Cancel reason', d.cancelReason],
              ]}
            />
          </CardContent>
        </Card>
      </div>
      <ReasonDialog
        open={cancel}
        onOpenChange={setCancel}
        title={`Cancel ${d.documentNumber}?`}
        description={
          d.status === 'DELIVERED'
            ? 'Stock returns to the warehouse and the cost of goods entry is reversed.'
            : undefined
        }
        confirmLabel="Cancel delivery"
        destructive
        loading={action.isPending}
        onConfirm={async (reason) => {
          try {
            await action.mutateAsync({ id, action: 'cancel', reason });
            toast.success('Delivery cancelled.');
            setCancel(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
