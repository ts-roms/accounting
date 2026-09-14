'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, ArrowLeft, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Money } from '@accounting/money';
import {
  ADJUSTMENT_REASONS,
  P,
  STOCK_DOCUMENT_STATUSES,
  type AdjustmentReason,
  type StockDocumentStatus,
  type StockDocumentType,
} from '@accounting/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
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
import {
  useCreateStockDocument,
  useDeleteStockDocument,
  useStockDocument,
  useStockDocumentAction,
  useStockDocuments,
  useStockOnHand,
} from '@/lib/api/inventory-hooks';
import type { Product, StockDocument } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { trimAmount } from '@/components/subledger/document-detail';
import { parseSerials, ProductCombobox, WarehouseSelect } from './pickers';
import { PRODUCTS_PATH } from './products';

export interface StockDocumentConfig {
  type: StockDocumentType;
  singular: string;
  plural: string;
  path: string;
  description: string;
}

export const ADJUSTMENTS_CONFIG: StockDocumentConfig = {
  type: 'ADJUSTMENT',
  singular: 'Stock adjustment',
  plural: 'Stock adjustments',
  path: '/inventory/adjustments',
  description:
    'Stock found, damaged, expired or corrected. Posting moves the stock and books the gain or loss to the inventory adjustments account.',
};
export const TRANSFERS_CONFIG: StockDocumentConfig = {
  type: 'TRANSFER',
  singular: 'Stock transfer',
  plural: 'Stock transfers',
  path: '/inventory/transfers',
  description:
    'Move stock between warehouses at cost. No journal entry: the inventory account is unchanged.',
};
export const COUNTS_CONFIG: StockDocumentConfig = {
  type: 'COUNT',
  singular: 'Stock count',
  plural: 'Stock counts',
  path: '/inventory/counts',
  description:
    'Physical counts. The system quantity is snapshotted when the count is created; posting adjusts the variance and books it.',
};

const STATUS_VARIANT: Record<StockDocumentStatus, 'secondary' | 'success' | 'destructive'> = {
  DRAFT: 'secondary',
  POSTED: 'success',
  CANCELLED: 'destructive',
};
const qty = (v: string | null) => (v === null ? '-' : trimAmount(v));

export function StockDocumentsPage({ cfg }: { cfg: StockDocumentConfig }) {
  const router = useRouter();
  const table = useTableState({ sortBy: 'documentDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const docs = useStockDocuments(cfg.type, {
    ...table.query,
    status: status === 'ALL' ? undefined : (status as StockDocumentStatus),
  });
  const columns = React.useMemo<ColumnDef<StockDocument>[]>(
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
        id: 'warehouse',
        header: cfg.type === 'TRANSFER' ? 'From → To' : 'Warehouse',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.warehouseCode}
            {row.original.toWarehouseCode ? ` → ${row.original.toWarehouseCode}` : ''}
          </span>
        ),
      },
      {
        id: 'reason',
        header: cfg.type === 'ADJUSTMENT' ? 'Reason' : 'Reference',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {cfg.type === 'ADJUSTMENT'
              ? titleCase(row.original.reason ?? '')
              : (row.original.reference ?? '-')}
          </span>
        ),
      },
      {
        id: 'lines',
        header: 'Lines',
        enableSorting: false,
        cell: ({ row }) => row.original.lineCount,
      },
      {
        id: 'value',
        header: () => <div className="text-right">Value</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.totalCost} currency={row.original.currency} zeroAsDash />
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={STATUS_VARIANT[row.original.status]}>{row.original.status}</Badge>
        ),
      },
    ],
    [cfg],
  );
  return (
    <>
      <PageHeader
        title={cfg.plural}
        description={cfg.description}
        actions={
          <Can permissions={[P['inventory.adjust']]}>
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
        data={docs.data}
        isLoading={docs.isLoading}
        isFetching={docs.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(d) => d.id}
        onRowClick={(d) => router.push(`${cfg.path}/${d.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Number, reference, notes"
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
                {STOCK_DOCUMENT_STATUSES.map((s) => (
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

// ------------------------------------------------------------------- form

interface LineDraft {
  key: string;
  productId: string | null;
  product: Product | null;
  direction: 'IN' | 'OUT';
  quantity: string;
  unitCost: string;
  countedQuantity: string;
  lotNumber: string;
  expiryDate: string;
  serials: string;
  notes: string;
}

const newLine = (): LineDraft => ({
  key: crypto.randomUUID(),
  productId: null,
  product: null,
  direction: 'OUT',
  quantity: '',
  unitCost: '',
  countedQuantity: '',
  lotNumber: '',
  expiryDate: '',
  serials: '',
  notes: '',
});

export function NewStockDocumentScreen({ cfg }: { cfg: StockDocumentConfig }) {
  const router = useRouter();
  const create = useCreateStockDocument(cfg.type);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [toWarehouseId, setToWarehouseId] = React.useState<string | null>(null);
  const [documentDate, setDocumentDate] = React.useState(today());
  const [reason, setReason] = React.useState<AdjustmentReason>('CORRECTION');
  const [reference, setReference] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineDraft[]>([newLine()]);
  const onHand = useStockOnHand(
    { warehouseId: warehouseId ?? undefined, includeZero: true },
    Boolean(warehouseId),
  );
  const update = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const isQty = (v: string) => /^\d{1,12}(\.\d{1,4})?$/.test(v.trim()) && Number(v) > 0;
  const stockOf = (productId: string | null, lot: string) =>
    onHand.data?.rows
      .filter((r) => r.productId === productId && (!lot || r.lotNumber === lot))
      .reduce((s, r) => s + Number(r.quantityOnHand), 0) ?? 0;
  const valid =
    warehouseId &&
    (cfg.type !== 'TRANSFER' || (toWarehouseId && toWarehouseId !== warehouseId)) &&
    lines.length > 0 &&
    lines.every(
      (l) =>
        l.productId &&
        (cfg.type === 'COUNT'
          ? /^\d{1,12}(\.\d{1,4})?$/.test(l.countedQuantity.trim())
          : isQty(l.quantity)) &&
        (cfg.type !== 'ADJUSTMENT' || l.direction === 'OUT' || isQty(l.unitCost)),
    );

  const submit = async () => {
    try {
      const base = {
        warehouseId: warehouseId!,
        documentDate,
        reference: reference || undefined,
        notes: notes || undefined,
        idempotencyKey: crypto.randomUUID(),
      };
      const identity = (l: LineDraft) => ({
        lotNumber: l.lotNumber || undefined,
        serialNumbers: l.serials.trim() ? parseSerials(l.serials) : undefined,
      });
      const payload =
        cfg.type === 'ADJUSTMENT'
          ? {
              ...base,
              reason,
              lines: lines.map((l) => ({
                productId: l.productId!,
                direction: l.direction,
                quantity: l.quantity.trim(),
                unitCost: l.direction === 'IN' ? l.unitCost.trim() : undefined,
                expiryDate: l.expiryDate || undefined,
                notes: l.notes || undefined,
                ...identity(l),
              })),
            }
          : cfg.type === 'TRANSFER'
            ? {
                ...base,
                toWarehouseId: toWarehouseId!,
                lines: lines.map((l) => ({
                  productId: l.productId!,
                  quantity: l.quantity.trim(),
                  notes: l.notes || undefined,
                  ...identity(l),
                })),
              }
            : {
                ...base,
                lines: lines.map((l) => ({
                  productId: l.productId!,
                  lotNumber: l.lotNumber || undefined,
                  countedQuantity: l.countedQuantity.trim(),
                  unitCost: l.unitCost.trim() || undefined,
                  notes: l.notes || undefined,
                })),
              };
      const created = await create.mutateAsync(payload);
      toast.success(`${created.documentNumber} saved as draft.`);
      router.push(`${cfg.path}/${created.id}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title={`New ${cfg.singular.toLowerCase()}`}
        description="Saved as a draft; nothing moves until it is posted."
      />
      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-4">
          <div className="space-y-1.5">
            <Label>{cfg.type === 'TRANSFER' ? 'From warehouse' : 'Warehouse'}</Label>
            <WarehouseSelect
              value={warehouseId}
              onChange={setWarehouseId}
              excludeId={toWarehouseId}
            />
          </div>
          {cfg.type === 'TRANSFER' ? (
            <div className="space-y-1.5">
              <Label>To warehouse</Label>
              <WarehouseSelect
                value={toWarehouseId}
                onChange={setToWarehouseId}
                excludeId={warehouseId}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="sd-date">Date</Label>
            <Input
              id="sd-date"
              type="date"
              value={documentDate}
              onChange={(e) => setDocumentDate(e.target.value)}
            />
          </div>
          {cfg.type === 'ADJUSTMENT' ? (
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as AdjustmentReason)}>
                <SelectTrigger data-testid="adjustment-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADJUSTMENT_REASONS.filter((r) => r !== 'COUNT_VARIANCE').map((r) => (
                    <SelectItem key={r} value={r}>
                      {titleCase(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="sd-ref">Reference</Label>
            <Input id="sd-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-4">
            <Label htmlFor="sd-notes">Notes</Label>
            <Textarea
              id="sd-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>
      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10">#</TableHead>
              <TableHead className="min-w-[260px]">Product</TableHead>
              <TableHead className="w-28 text-right">On hand</TableHead>
              {cfg.type === 'ADJUSTMENT' ? <TableHead className="w-28">Direction</TableHead> : null}
              <TableHead className="w-28 text-right">
                {cfg.type === 'COUNT' ? 'Counted' : 'Quantity'}
              </TableHead>
              {cfg.type !== 'TRANSFER' ? (
                <TableHead className="w-32 text-right">Unit cost</TableHead>
              ) : null}
              <TableHead className="w-36">Lot</TableHead>
              <TableHead className="min-w-[160px]">Serials</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, index) => {
              const tracked = l.product?.trackingMode ?? 'NONE';
              return (
                <TableRow key={l.key} className="hover:bg-transparent">
                  <TableCell className="text-xs text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <ProductCombobox
                      value={l.productId}
                      goodsOnly
                      onChange={(id, p) =>
                        update(l.key, {
                          productId: id,
                          product: p,
                          unitCost:
                            l.unitCost || (p?.purchasePrice ? trimAmount(p.purchasePrice) : ''),
                        })
                      }
                    />
                  </TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {l.productId && warehouseId ? stockOf(l.productId, l.lotNumber) : '-'}
                  </TableCell>
                  {cfg.type === 'ADJUSTMENT' ? (
                    <TableCell>
                      <Select
                        value={l.direction}
                        onValueChange={(v) => update(l.key, { direction: v as 'IN' | 'OUT' })}
                      >
                        <SelectTrigger aria-label={`Direction for line ${index + 1}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="IN">Stock in</SelectItem>
                          <SelectItem value="OUT">Stock out</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  ) : null}
                  <TableCell>
                    {cfg.type === 'COUNT' ? (
                      <Input
                        inputMode="decimal"
                        className="tabular text-right"
                        aria-label={`Counted quantity for line ${index + 1}`}
                        value={l.countedQuantity}
                        onChange={(e) => update(l.key, { countedQuantity: e.target.value })}
                      />
                    ) : (
                      <Input
                        inputMode="decimal"
                        className="tabular text-right"
                        aria-label={`Quantity for line ${index + 1}`}
                        value={l.quantity}
                        onChange={(e) => update(l.key, { quantity: e.target.value })}
                      />
                    )}
                  </TableCell>
                  {cfg.type !== 'TRANSFER' ? (
                    <TableCell>
                      <Input
                        inputMode="decimal"
                        className="tabular text-right"
                        aria-label={`Unit cost for line ${index + 1}`}
                        value={l.unitCost}
                        disabled={cfg.type === 'ADJUSTMENT' && l.direction === 'OUT'}
                        placeholder={
                          cfg.type === 'ADJUSTMENT' && l.direction === 'OUT'
                            ? 'at cost'
                            : cfg.type === 'COUNT'
                              ? 'current'
                              : ''
                        }
                        onChange={(e) => update(l.key, { unitCost: e.target.value })}
                      />
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <Input
                      aria-label={`Lot for line ${index + 1}`}
                      value={l.lotNumber}
                      disabled={tracked !== 'LOT'}
                      placeholder={tracked === 'LOT' ? 'Lot no.' : '-'}
                      onChange={(e) => update(l.key, { lotNumber: e.target.value })}
                    />
                    {tracked === 'LOT' && cfg.type === 'ADJUSTMENT' && l.direction === 'IN' ? (
                      <Input
                        type="date"
                        className="mt-1"
                        aria-label={`Expiry for line ${index + 1}`}
                        value={l.expiryDate}
                        onChange={(e) => update(l.key, { expiryDate: e.target.value })}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={`Serial numbers for line ${index + 1}`}
                      value={l.serials}
                      disabled={tracked !== 'SERIAL' || cfg.type === 'COUNT'}
                      placeholder={tracked === 'SERIAL' ? 'SN1, SN2, ...' : '-'}
                      onChange={(e) => update(l.key, { serials: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove line"
                      disabled={lines.length <= 1}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={9}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLines((ls) => [...ls, newLine()])}
                >
                  <Plus /> Add line
                </Button>
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => router.push(cfg.path)}>
          Cancel
        </Button>
        <Button disabled={!valid} loading={create.isPending} onClick={() => void submit()}>
          Save draft
        </Button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ detail

export function StockDocumentDetailPage({ cfg, id }: { cfg: StockDocumentConfig; id: string }) {
  const router = useRouter();
  const { hasPermission } = useSession();
  const doc = useStockDocument(cfg.type, id);
  const action = useStockDocumentAction(cfg.type);
  const remove = useDeleteStockDocument(cfg.type);
  const [posting, setPosting] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  if (doc.isLoading || !doc.data) return <Skeleton className="h-96" />;
  const d = doc.data;
  const isDraft = d.status === 'DRAFT';
  const canEdit = isDraft && hasPermission(P['inventory.adjust']);
  const canPost = isDraft && hasPermission(P['inventory.post']);
  const net = d.lines.reduce(
    (s, l) =>
      l.totalCost
        ? s.add(
            l.direction === 'IN'
              ? Money.of(l.totalCost, d.currency)
              : Money.of(l.totalCost, d.currency).negate(),
          )
        : s,
    Money.zero(d.currency),
  );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{d.documentNumber}</span>
            <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
            {d.reason ? <Badge variant="outline">{titleCase(d.reason)}</Badge> : null}
          </span>
        }
        description={
          d.notes ??
          `${cfg.singular} at ${d.warehouseName}${d.toWarehouseName ? ` → ${d.toWarehouseName}` : ''}`
        }
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={cfg.path}>
                <ArrowLeft /> All {cfg.plural.toLowerCase()}
              </Link>
            </Button>
            {canEdit ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                  <Trash2 /> Delete
                </Button>
                <Button variant="outline" size="sm" onClick={() => setCancelling(true)}>
                  <X /> Cancel
                </Button>
              </>
            ) : null}
            {canPost ? (
              <Button size="sm" onClick={() => setPosting(true)}>
                Post
              </Button>
            ) : null}
          </>
        }
      />
      {d.status === 'CANCELLED' ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Cancelled</AlertTitle>
          <AlertDescription>{d.cancelReason}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Lot / serials</TableHead>
                  {cfg.type === 'COUNT' ? (
                    <>
                      <TableHead className="text-right">System</TableHead>
                      <TableHead className="text-right">Counted</TableHead>
                    </>
                  ) : null}
                  <TableHead className="text-right">
                    {cfg.type === 'COUNT' ? 'Variance' : 'Quantity'}
                  </TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">{l.lineNumber}</TableCell>
                    <TableCell>
                      <Link href={`${PRODUCTS_PATH}/${l.productId}`} className="hover:underline">
                        <span className="font-mono text-xs text-muted-foreground">{l.sku}</span>{' '}
                        {l.productName}
                      </Link>
                      {l.notes ? (
                        <div className="text-xs text-muted-foreground">{l.notes}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      {l.lotNumber ?? ''}
                      {l.serialNumbers.length ? (
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {l.serialNumbers.join(', ')}
                        </div>
                      ) : null}
                    </TableCell>
                    {cfg.type === 'COUNT' ? (
                      <>
                        <TableCell className="tabular text-right">
                          {qty(l.expectedQuantity)}
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {qty(l.countedQuantity)}
                        </TableCell>
                      </>
                    ) : null}
                    <TableCell
                      className={`tabular text-right ${cfg.type !== 'TRANSFER' && l.direction === 'OUT' ? 'text-destructive' : ''}`}
                    >
                      {cfg.type !== 'TRANSFER' ? (l.direction === 'OUT' ? '-' : '+') : ''}
                      {qty(l.quantity)} {l.unitOfMeasure}
                    </TableCell>
                    <TableCell>
                      {l.unitCost ? (
                        <Amount value={l.unitCost} currency={d.currency} />
                      ) : (
                        <span className="block text-right text-xs text-muted-foreground">
                          {isDraft ? 'on posting' : '-'}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {l.totalCost ? (
                        <Amount value={l.totalCost} currency={d.currency} />
                      ) : (
                        <span className="block text-right text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {d.status === 'POSTED' ? (
                <TableFooter>
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={cfg.type === 'COUNT' ? 7 : 5}
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {cfg.type === 'TRANSFER' ? 'Value transferred' : 'Net inventory change'}
                    </TableCell>
                    <TableCell>
                      <Amount
                        value={cfg.type === 'TRANSFER' ? d.totalCost : net.toString()}
                        currency={d.currency}
                        className="font-semibold"
                      />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{cfg.singular}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">
                {cfg.type === 'TRANSFER' ? 'From' : 'Warehouse'}
              </dt>
              <dd>
                <span className="font-mono text-xs text-muted-foreground">{d.warehouseCode}</span>{' '}
                {d.warehouseName}
              </dd>
              {d.toWarehouseCode ? (
                <>
                  <dt className="text-muted-foreground">To</dt>
                  <dd>
                    <span className="font-mono text-xs text-muted-foreground">
                      {d.toWarehouseCode}
                    </span>{' '}
                    {d.toWarehouseName}
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Date</dt>
              <dd>{d.documentDate}</dd>
              <dt className="text-muted-foreground">Reference</dt>
              <dd>{d.reference ?? '-'}</dd>
              <dt className="text-muted-foreground">Journal</dt>
              <dd>
                {d.journalEntryId ? (
                  <Link
                    href={`/accounting/journal-entries/${d.journalEntryId}`}
                    className="font-mono hover:underline"
                  >
                    {d.journalNumber}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">
                    {d.status === 'POSTED' ? 'none (no value change)' : '-'}
                  </span>
                )}
              </dd>
            </dl>
            <div className="mt-4 space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>Created</span>
                <span>{formatDateTime(d.createdAt)}</span>
              </div>
              {d.postedAt ? (
                <div className="flex justify-between">
                  <span>Posted</span>
                  <span>{formatDateTime(d.postedAt)}</span>
                </div>
              ) : null}
            </div>
            <Button variant="link" size="sm" className="mt-2 px-0" asChild>
              <Link href={`/admin/audit-logs?entityId=${d.id}`}>View audit trail</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={posting}
        onOpenChange={setPosting}
        title={`Post ${d.documentNumber}?`}
        description={
          cfg.type === 'TRANSFER'
            ? 'Moves the stock at cost from the source to the destination warehouse. No journal entry.'
            : 'Moves the stock and posts the value change to inventory and the inventory adjustments account. Posted documents cannot be edited.'
        }
        confirmLabel="Post"
        loading={action.isPending}
        onConfirm={async () => {
          try {
            await action.mutateAsync({ id: d.id, action: 'post' });
            toast.success(`${d.documentNumber} posted.`);
            setPosting(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete draft ${d.documentNumber}?`}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(d.id);
            toast.success('Draft deleted.');
            router.push(cfg.path);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Cancel {d.documentNumber}</DialogTitle>
            <DialogDescription>
              The draft keeps its number and cannot be reopened.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="sd-cancel-reason">Reason</Label>
            <Textarea
              id="sd-cancel-reason"
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
                  await action.mutateAsync({ id: d.id, action: 'cancel', reason: reason.trim() });
                  toast.success(`${d.documentNumber} cancelled.`);
                  setCancelling(false);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Cancel document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
