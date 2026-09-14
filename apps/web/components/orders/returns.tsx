'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, ArrowLeft, Check, FileMinus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { RETURN_STATUSES, type ReturnStatus } from '@accounting/types';
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useDeleteReturn, useReturn, useReturnAction, useReturns } from '@/lib/api/orders-hooks';
import type { ReturnDocument } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import type { ReturnsConfig } from '@/lib/orders/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { trimAmount } from '@/components/subledger/document-detail';
import { ReturnStatusBadge } from './badges';

export function ReturnsPage({ cfg }: { cfg: ReturnsConfig }) {
  const router = useRouter();
  const table = useTableState({ sortBy: 'returnDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const returns = useReturns(cfg, {
    ...table.query,
    status: status === 'ALL' ? undefined : (status as ReturnStatus),
  });

  const columns = React.useMemo<ColumnDef<ReturnDocument>[]>(
    () => [
      {
        accessorKey: 'returnDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.returnDate}</span>,
      },
      {
        accessorKey: 'documentNumber',
        header: 'Return',
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
        id: 'order',
        header: cfg.order.singular,
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`${cfg.order.path}/${row.original.orderId}`}
            className="font-mono text-xs hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.orderNumber}
          </Link>
        ),
      },
      {
        id: 'party',
        header: cfg.order.subledger.party.singular,
        enableSorting: false,
        cell: ({ row }) => row.original.partyName,
      },
      {
        id: 'credit',
        header: cfg.creditNoteLabel,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.creditNoteNumber ? (
            <span className="font-mono text-xs">{row.original.creditNoteNumber}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
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
        cell: ({ row }) => <ReturnStatusBadge status={row.original.status} />,
      },
    ],
    [cfg],
  );

  return (
    <>
      <PageHeader
        title={cfg.plural}
        description={
          cfg.type === 'SALES'
            ? 'Goods coming back from customers. Recorded from the sales order; crediting issues a credit note that reverses the revenue.'
            : 'Goods sent back to vendors. Recorded from the purchase order; crediting issues a vendor credit note that reduces the payable.'
        }
      />
      <DataTable
        columns={columns}
        data={returns.data}
        isLoading={returns.isLoading}
        isFetching={returns.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`${cfg.path}/${r.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Return, order, party"
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
                {RETURN_STATUSES.map((s) => (
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
            description={`Record a return from an approved ${cfg.order.singular.toLowerCase()}.`}
          />
        }
      />
    </>
  );
}

export function ReturnDetailPage({ cfg, id }: { cfg: ReturnsConfig; id: string }) {
  const router = useRouter();
  const { hasPermission } = useSession();
  const ret = useReturn(cfg, id);
  const action = useReturnAction(cfg);
  const remove = useDeleteReturn(cfg);
  const [approving, setApproving] = React.useState(false);
  const [crediting, setCrediting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [documentDate, setDocumentDate] = React.useState(today());

  if (ret.isLoading || !ret.data) return <Skeleton className="h-96" />;
  const r = ret.data;
  const canCreate = hasPermission(cfg.permissions.create);
  const canApprove = hasPermission(cfg.permissions.approve);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{r.documentNumber}</span>
            <ReturnStatusBadge status={r.status} />
          </span>
        }
        description={r.reason ?? `${cfg.singular} against ${r.orderNumber}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={cfg.path}>
                <ArrowLeft /> All {cfg.plural.toLowerCase()}
              </Link>
            </Button>
            {canCreate && r.status === 'DRAFT' ? (
              <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            ) : null}
            {canCreate && (r.status === 'DRAFT' || r.status === 'APPROVED') ? (
              <Button variant="outline" size="sm" onClick={() => setCancelling(true)}>
                <X /> Cancel
              </Button>
            ) : null}
            {canApprove && r.status === 'DRAFT' ? (
              <Button size="sm" onClick={() => setApproving(true)}>
                <Check /> Approve
              </Button>
            ) : null}
            {canApprove && r.status === 'APPROVED' ? (
              <Button size="sm" onClick={() => setCrediting(true)}>
                <FileMinus /> Issue {cfg.creditNoteLabel.toLowerCase()}
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
            <CardTitle>Returned lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-24 text-right">Qty</TableHead>
                  <TableHead className="w-32 text-right">Net price</TableHead>
                  <TableHead className="w-32 text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">{l.lineNumber}</TableCell>
                    <TableCell>
                      <div>{l.description}</div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{l.accountCode}</span> {l.accountName}
                        {l.reason ? ` - ${l.reason}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="tabular text-right">{trimAmount(l.quantity)}</TableCell>
                    <TableCell>
                      <Amount value={l.unitPrice} currency={r.currency} />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.amount} currency={r.currency} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={4}
                    className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Total ({r.currency})
                  </TableCell>
                  <TableCell>
                    <Amount value={r.total} currency={r.currency} className="font-semibold" />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Return</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">{cfg.order.singular}</dt>
              <dd>
                <Link href={`${cfg.order.path}/${r.orderId}`} className="font-mono hover:underline">
                  {r.orderNumber}
                </Link>
              </dd>
              <dt className="text-muted-foreground">{cfg.order.subledger.party.singular}</dt>
              <dd>
                <Link
                  href={`${cfg.order.subledger.party.path}/${r.partyId}`}
                  className="hover:underline"
                >
                  {r.partyName}
                </Link>
              </dd>
              <dt className="text-muted-foreground">Date</dt>
              <dd>{r.returnDate}</dd>
              <dt className="text-muted-foreground">Reference</dt>
              <dd>{r.reference ?? '-'}</dd>
              <dt className="text-muted-foreground">{cfg.creditNoteLabel}</dt>
              <dd>
                {r.creditNoteId ? (
                  <Link
                    href={`${cfg.creditNotePath}/${r.creditNoteId}`}
                    className="font-mono hover:underline"
                  >
                    {r.creditNoteNumber}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Not issued</span>
                )}
              </dd>
            </dl>
            <div className="mt-4 space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>Created</span>
                <span>{formatDateTime(r.createdAt)}</span>
              </div>
              {r.approvedAt ? (
                <div className="flex justify-between">
                  <span>Approved</span>
                  <span>{formatDateTime(r.approvedAt)}</span>
                </div>
              ) : null}
              {r.creditedAt ? (
                <div className="flex justify-between">
                  <span>Credited</span>
                  <span>{formatDateTime(r.creditedAt)}</span>
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
        open={approving}
        onOpenChange={setApproving}
        title={`Approve ${r.documentNumber}?`}
        description="Approval confirms the goods and quantities. Nothing is posted until the credit note is issued and posted."
        confirmLabel="Approve"
        loading={action.isPending}
        onConfirm={async () => {
          try {
            await action.mutateAsync({ id: r.id, action: 'approve' });
            toast.success(`${r.documentNumber} approved.`);
            setApproving(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <Dialog open={crediting} onOpenChange={setCrediting}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Issue {cfg.creditNoteLabel.toLowerCase()}</DialogTitle>
            <DialogDescription>
              Raises a draft {cfg.creditNoteLabel.toLowerCase()} for {r.currency} {r.total} at the
              order&apos;s net prices and records the returned quantities. Approve and post it from
              the {cfg.type === 'SALES' ? 'invoices' : 'bills'} screen, then apply it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="credit-date">Document date</Label>
            <Input
              id="credit-date"
              type="date"
              value={documentDate}
              onChange={(e) => setDocumentDate(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCrediting(false)}>
              Cancel
            </Button>
            <Button
              loading={action.isPending}
              onClick={async () => {
                try {
                  const updated = await action.mutateAsync({
                    id: r.id,
                    action: 'credit',
                    documentDate,
                  });
                  toast.success(`${updated.creditNoteNumber} created as a draft.`);
                  setCrediting(false);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Issue {cfg.creditNoteLabel.toLowerCase()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Cancel {r.documentNumber}</DialogTitle>
            <DialogDescription>
              The return keeps its number and cannot be reopened.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="ret-cancel-reason">Reason</Label>
            <Textarea
              id="ret-cancel-reason"
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
              Cancel return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            router.push(cfg.path);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
