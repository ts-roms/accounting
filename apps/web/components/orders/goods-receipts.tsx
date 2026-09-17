'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, ArrowLeft, Check, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { GOODS_RECEIPT_STATUSES, P, type GoodsReceiptStatus } from '@accounting/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useDeleteGoodsReceipt,
  useGoodsReceipt,
  useGoodsReceiptAction,
  useGoodsReceipts,
} from '@/lib/api/orders-hooks';
import type { GoodsReceipt } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { GOODS_RECEIPTS_PATH, PURCHASE_ORDER_CONFIG } from '@/lib/orders/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { trimAmount } from '@/components/subledger/document-detail';
import { ReceiptStatusBadge } from './badges';

export function GoodsReceiptsPage() {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'receiptDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const receipts = useGoodsReceipts({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as GoodsReceiptStatus),
  });

  const columns = React.useMemo<ColumnDef<GoodsReceipt>[]>(
    () => [
      {
        accessorKey: 'receiptDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.receiptDate}</span>,
      },
      {
        accessorKey: 'documentNumber',
        header: 'Receipt',
        cell: ({ row }) => (
          <Link
            href={`${GOODS_RECEIPTS_PATH}/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.documentNumber}
          </Link>
        ),
      },
      {
        id: 'po',
        header: 'Purchase order',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`${PURCHASE_ORDER_CONFIG.path}/${row.original.purchaseOrderId}`}
            className="font-mono text-xs hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.purchaseOrderNumber}
          </Link>
        ),
      },
      {
        id: 'vendor',
        header: 'Vendor',
        enableSorting: false,
        cell: ({ row }) => row.original.vendorName,
      },
      {
        id: 'reference',
        header: 'Delivery note',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground">{row.original.reference ?? '-'}</span>
        ),
      },
      {
        id: 'lines',
        header: 'Lines',
        enableSorting: false,
        cell: ({ row }) => row.original.lineCount,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <ReceiptStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Goods receipts"
        description="What arrived against purchase orders. Receipts are recorded from the purchase order and confirmed here; they have no ledger effect until inventory valuation (Phase 5)."
      />
      <DataTable
        columns={columns}
        data={receipts.data}
        isLoading={receipts.isLoading}
        isFetching={receipts.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`${GOODS_RECEIPTS_PATH}/${r.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Receipt, PO, delivery note, vendor"
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
                {GOODS_RECEIPT_STATUSES.map((s) => (
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
            title="No goods receipts"
            description="Record a receipt from an approved purchase order."
          />
        }
      />
    </>
  );
}

export function GoodsReceiptDetailPage({ id }: { id: string }) {
  const router = useAppRouter();
  const { hasPermission } = useSession();
  const receipt = useGoodsReceipt(id);
  const action = useGoodsReceiptAction();
  const remove = useDeleteGoodsReceipt();
  const [confirming, setConfirming] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [reason, setReason] = React.useState('');

  if (receipt.isLoading || !receipt.data) return <Skeleton className="h-96" />;
  const r = receipt.data;
  const canManage = hasPermission(P['goods-receipt.create']);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{r.documentNumber}</span>
            <ReceiptStatusBadge status={r.status} />
          </span>
        }
        description={`Goods received from ${r.vendorName} against ${r.purchaseOrderNumber}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={GOODS_RECEIPTS_PATH}>
                <ArrowLeft /> All receipts
              </Link>
            </Button>
            {canManage && r.status === 'DRAFT' ? (
              <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            ) : null}
            {canManage && r.status !== 'CANCELLED' ? (
              <Button variant="outline" size="sm" onClick={() => setCancelling(true)}>
                <X /> Cancel receipt
              </Button>
            ) : null}
            {canManage && r.status === 'DRAFT' ? (
              <Button size="sm" onClick={() => setConfirming(true)}>
                <Check /> Confirm receipt
              </Button>
            ) : null}
          </>
        }
      />
      {r.status === 'CANCELLED' ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Cancelled</AlertTitle>
          <AlertDescription>{r.cancelReason}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Received lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-24 text-right">Ordered</TableHead>
                  <TableHead className="w-24 text-right">Received</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">{l.lineNumber}</TableCell>
                    <TableCell>{l.description}</TableCell>
                    <TableCell className="tabular text-right">
                      {trimAmount(l.orderedQuantity)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {trimAmount(l.quantity)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{l.notes ?? ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Receipt</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Purchase order</dt>
              <dd>
                <Link
                  href={`${PURCHASE_ORDER_CONFIG.path}/${r.purchaseOrderId}`}
                  className="font-mono hover:underline"
                >
                  {r.purchaseOrderNumber}
                </Link>
              </dd>
              <dt className="text-muted-foreground">Vendor</dt>
              <dd>
                <Link href={`/purchasing/vendors/${r.vendorId}`} className="hover:underline">
                  {r.vendorName}
                </Link>
              </dd>
              <dt className="text-muted-foreground">Date</dt>
              <dd>{r.receiptDate}</dd>
              <dt className="text-muted-foreground">Delivery note</dt>
              <dd>{r.reference ?? '-'}</dd>
              {r.notes ? (
                <>
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd className="whitespace-pre-wrap">{r.notes}</dd>
                </>
              ) : null}
            </dl>
            <div className="mt-4 space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>Created</span>
                <span>{formatDateTime(r.createdAt)}</span>
              </div>
              {r.confirmedAt ? (
                <div className="flex justify-between">
                  <span>Confirmed</span>
                  <span>{formatDateTime(r.confirmedAt)}</span>
                </div>
              ) : null}
            </div>
            <Button variant="link" size="sm" className="mt-2 px-0" asChild>
              <Link href={`/admin/audit-logs?entityId=${r.id}`}>View audit trail</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Confirm ${r.documentNumber}?`}
        description="Adds the received quantities to the purchase order and re-runs the three-way match on its bills. Over-receipt beyond the configured tolerance is rejected."
        confirmLabel="Confirm receipt"
        loading={action.isPending}
        onConfirm={async () => {
          try {
            await action.mutateAsync({ id: r.id, action: 'confirm' });
            toast.success(`${r.documentNumber} confirmed.`);
            setConfirming(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete draft ${r.documentNumber}?`}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(r.id);
            toast.success('Draft deleted.');
            router.push(GOODS_RECEIPTS_PATH);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Cancel {r.documentNumber}</DialogTitle>
            <DialogDescription>
              {r.status === 'CONFIRMED'
                ? 'Releases the received quantities on the purchase order. Refused when a bill already covers them - void the bill first.'
                : 'The draft is marked cancelled and keeps its number.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="gr-cancel-reason">Reason</Label>
            <Textarea
              id="gr-cancel-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(false)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim()}
              loading={action.isPending}
              onClick={async () => {
                try {
                  await action.mutateAsync({ id: r.id, action: 'cancel', reason: reason.trim() });
                  toast.success(`${r.documentNumber} cancelled.`);
                  setCancelling(false);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Cancel receipt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
