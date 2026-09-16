'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Check,
  FileText,
  PackageCheck,
  Pencil,
  Trash2,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Money } from '@accounting/money';
import { P, type OrderStatus } from '@accounting/types';
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
  useConvertOrder,
  useCreateGoodsReceipt,
  useCreateReturn,
  useDeleteOrder,
  useFulfilOrder,
  useGoodsReceipts,
  useOrder,
  useOrderAction,
  useReturns,
} from '@/lib/api/orders-hooks';
import type { OrderDetail, OrderLine, SodConflict } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import {
  GOODS_RECEIPTS_PATH,
  PURCHASE_RETURNS_CONFIG,
  SALES_RETURNS_CONFIG,
  type OrderConfig,
} from '@/lib/orders/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { DocumentStatusBadge } from '@/components/subledger/badges';
import { trimAmount } from '@/components/subledger/document-detail';
import {
  FulfillmentBadge,
  MatchStatusBadge,
  OrderStatusBadge,
  ReceiptStatusBadge,
  ReturnStatusBadge,
} from './badges';
import { SalesOrderArPanel } from '@/components/receivables/order-panel';

export function OrderDetailPage({ cfg, id }: { cfg: OrderConfig; id: string }) {
  const router = useRouter();
  const { hasPermission } = useSession();
  const order = useOrder(cfg, id);
  const action = useOrderAction(cfg);
  const remove = useDeleteOrder(cfg);
  const receipts = useGoodsReceipts({ purchaseOrderId: id, pageSize: 50 }, cfg.tracksReceipts);
  const returnsCfg =
    cfg.type === 'SALES_ORDER'
      ? SALES_RETURNS_CONFIG
      : cfg.type === 'PURCHASE_ORDER'
        ? PURCHASE_RETURNS_CONFIG
        : null;
  const returns = useReturns(
    returnsCfg ?? SALES_RETURNS_CONFIG,
    { orderId: id, pageSize: 50 },
    Boolean(returnsCfg),
  );
  const [pending, setPending] = React.useState<OrderConfig['actions'][number] | null>(null);
  const [reason, setReason] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  const [converting, setConverting] = React.useState(false);
  const [fulfilling, setFulfilling] = React.useState(false);
  const [receiving, setReceiving] = React.useState(false);
  const [returning, setReturning] = React.useState(false);
  const [warnings, setWarnings] = React.useState<SodConflict[]>([]);

  if (order.isLoading || !order.data) return <Skeleton className="h-96" />;
  const o = order.data;
  const sub = cfg.subledger;
  const editable =
    (['DRAFT', 'REJECTED'] as OrderStatus[]).includes(o.status) &&
    hasPermission(cfg.permissions.create);
  const available = cfg.actions.filter(
    (a) => a.from.includes(o.status) && hasPermission(a.permission),
  );
  const canConvert =
    cfg.convert &&
    (o.status === 'ACCEPTED' || (cfg.type === 'PURCHASE_REQUEST' && o.status === 'APPROVED')) &&
    hasPermission(cfg.convert.permission);
  const openForFulfilment = o.status === 'APPROVED' || o.status === 'CONFIRMED';
  const canFulfil =
    cfg.fulfil &&
    openForFulfilment &&
    o.lines.some((l) => Money.of(l.remainingToBill, o.currency).isPositive()) &&
    hasPermission(cfg.fulfil.permission);
  const canReceive =
    cfg.tracksReceipts &&
    openForFulfilment &&
    o.lines.some((l) => Money.of(l.remainingToReceive, o.currency).isPositive()) &&
    hasPermission(P['goods-receipt.create']);
  const canReturn =
    returnsCfg &&
    (o.status === 'APPROVED' || o.status === 'CLOSED') &&
    o.lines.some((l) => Money.of(l.remainingToReturn, o.currency).isPositive()) &&
    hasPermission(returnsCfg.permissions.create);

  const run = async (a: OrderConfig['actions'][number]) => {
    try {
      const result = await action.mutateAsync({
        id: o.id,
        action: a.action,
        reason: a.needsReason ? reason.trim() : undefined,
      });
      setWarnings(result.sodWarnings ?? []);
      toast.success(`${o.documentNumber}: ${a.label.toLowerCase()} done.`);
      setPending(null);
      setReason('');
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{o.documentNumber}</span>
            <OrderStatusBadge status={o.status} />
            {cfg.tracksReceipts && o.status !== 'DRAFT' ? (
              <FulfillmentBadge status={o.receiptStatus} label="Received" />
            ) : null}
            {cfg.tracksBilling && o.status !== 'DRAFT' ? (
              <FulfillmentBadge
                status={o.billingStatus}
                label={cfg.type === 'SALES_ORDER' ? 'Invoiced' : 'Billed'}
              />
            ) : null}
          </span>
        }
        description={o.description ?? `${cfg.singular} for ${o.partyName ?? 'unassigned'}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={cfg.path}>
                <ArrowLeft /> All {cfg.plural.toLowerCase()}
              </Link>
            </Button>
            {editable ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`${cfg.path}/${o.id}/edit`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                {o.status === 'DRAFT' ? (
                  <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                    <Trash2 /> Delete
                  </Button>
                ) : null}
              </>
            ) : null}
            {available
              .filter((a) => !a.primary)
              .map((a) => (
                <Button key={a.action} variant="outline" size="sm" onClick={() => setPending(a)}>
                  {a.label}
                </Button>
              ))}
            {canReturn ? (
              <Button variant="outline" size="sm" onClick={() => setReturning(true)}>
                <Undo2 /> Record return
              </Button>
            ) : null}
            {canReceive ? (
              <Button variant="outline" size="sm" onClick={() => setReceiving(true)}>
                <PackageCheck /> Receive goods
              </Button>
            ) : null}
            {canFulfil ? (
              <Button size="sm" onClick={() => setFulfilling(true)}>
                <FileText /> {cfg.fulfil!.label}
              </Button>
            ) : null}
            {canConvert ? (
              <Button size="sm" onClick={() => setConverting(true)}>
                <ArrowRightLeft /> {cfg.convert!.label}
              </Button>
            ) : null}
            {available
              .filter((a) => a.primary)
              .map((a) => (
                <Button key={a.action} size="sm" onClick={() => setPending(a)}>
                  <Check /> {a.label}
                </Button>
              ))}
          </>
        }
      />

      {o.status === 'REJECTED' && o.rejectionReason ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Rejected</AlertTitle>
          <AlertDescription>{o.rejectionReason}</AlertDescription>
        </Alert>
      ) : null}
      {o.status === 'CANCELLED' && o.cancelReason ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Cancelled</AlertTitle>
          <AlertDescription>{o.cancelReason}</AlertDescription>
        </Alert>
      ) : null}
      {cfg.type === 'SALES_ORDER' ? <SalesOrderArPanel order={o} /> : null}
      {warnings.length > 0 ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>Segregation-of-duties warning recorded</AlertTitle>
          <AlertDescription>
            {warnings.map((w) => (
              <div key={w.policyId}>{w.policyName}</div>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="w-24 text-right">Qty</TableHead>
                    <TableHead className="w-28 text-right">Unit price</TableHead>
                    <TableHead className="w-20 text-right">Disc %</TableHead>
                    <TableHead className="w-32 text-right">Amount</TableHead>
                    {cfg.tracksReceipts ? (
                      <TableHead className="w-24 text-right">Received</TableHead>
                    ) : null}
                    {cfg.tracksBilling ? (
                      <TableHead className="w-24 text-right">
                        {cfg.type === 'SALES_ORDER' ? 'Invoiced' : 'Billed'}
                      </TableHead>
                    ) : null}
                    {returnsCfg ? (
                      <TableHead className="w-24 text-right">Returned</TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {l.lineNumber}
                      </TableCell>
                      <TableCell>
                        <div>{l.description}</div>
                        <div className="text-xs text-muted-foreground">
                          <span className="font-mono">{l.accountCode}</span> {l.accountName}
                        </div>
                      </TableCell>
                      <TableCell className="tabular text-right">{trimAmount(l.quantity)}</TableCell>
                      <TableCell>
                        <Amount value={l.unitPrice} currency={o.currency} />
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {l.discountPercent === '0.0000' ? '-' : trimAmount(l.discountPercent)}
                      </TableCell>
                      <TableCell>
                        <Amount value={l.amount} currency={o.currency} />
                      </TableCell>
                      {cfg.tracksReceipts ? (
                        <TableCell className="tabular text-right">
                          {qty(l.receivedQuantity)}
                        </TableCell>
                      ) : null}
                      {cfg.tracksBilling ? (
                        <TableCell className="tabular text-right">
                          {qty(l.billedQuantity)}
                        </TableCell>
                      ) : null}
                      {returnsCfg ? (
                        <TableCell className="tabular text-right">
                          {qty(l.returnedQuantity)}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  {o.discountTotal !== '0.0000' ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={5}
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        Gross {o.subtotal} less discount {o.discountTotal}
                      </TableCell>
                      <TableCell colSpan={4} />
                    </TableRow>
                  ) : null}
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={5}
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      Total ({o.currency})
                    </TableCell>
                    <TableCell>
                      <Amount value={o.total} currency={o.currency} className="font-semibold" />
                    </TableCell>
                    <TableCell colSpan={3} />
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>

          {cfg.fulfil ? (
            <Card>
              <CardHeader>
                <CardTitle>{cfg.fulfil.documentSingular}s raised</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {o.documents.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">Nothing raised yet.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Date</TableHead>
                        <TableHead>Document</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="w-32 text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {o.documents.map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="whitespace-nowrap">{d.documentDate}</TableCell>
                          <TableCell>
                            <Link
                              href={`${cfg.fulfil!.documentPath}/${d.id}`}
                              className="font-mono text-xs hover:underline"
                            >
                              {d.documentNumber}
                            </Link>
                            {d.documentType !== 'INVOICE' ? (
                              <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                                {titleCase(d.documentType)}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <span className="flex flex-wrap gap-1">
                              <DocumentStatusBadge status={d.status as 'DRAFT'} />
                              {d.matchStatus ? <MatchStatusBadge status={d.matchStatus} /> : null}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Amount value={d.total} currency={o.currency} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ) : null}

          {cfg.tracksReceipts ? (
            <Card>
              <CardHeader>
                <CardTitle>Goods receipts</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {!receipts.data?.items.length ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    Nothing received yet. Receipts have no ledger effect until inventory valuation
                    (Phase 5).
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Date</TableHead>
                        <TableHead>Receipt</TableHead>
                        <TableHead>Reference</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {receipts.data.items.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap">{r.receiptDate}</TableCell>
                          <TableCell>
                            <Link
                              href={`${GOODS_RECEIPTS_PATH}/${r.id}`}
                              className="font-mono text-xs hover:underline"
                            >
                              {r.documentNumber}
                            </Link>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {r.reference ?? '-'}
                          </TableCell>
                          <TableCell>
                            <ReceiptStatusBadge status={r.status} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ) : null}

          {returnsCfg && returns.data?.items.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Returns</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Date</TableHead>
                      <TableHead>Return</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-32 text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {returns.data.items.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{r.returnDate}</TableCell>
                        <TableCell>
                          <Link
                            href={`${returnsCfg.path}/${r.id}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {r.documentNumber}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <ReturnStatusBadge status={r.status} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.total} currency={o.currency} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{cfg.singular}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-sm">
              <Field
                label={sub.party.singular}
                value={
                  o.partyId ? (
                    <Link href={`${sub.party.path}/${o.partyId}`} className="hover:underline">
                      {o.partyName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">Not assigned</span>
                  )
                }
              />
              <Field label="Date" value={o.orderDate} />
              <Field label={cfg.expectedDateLabel} value={o.expectedDate ?? '-'} />
              <Field label="Reference" value={o.reference ?? '-'} />
              {o.sourceOrderNumber ? (
                <Field
                  label="From"
                  value={
                    <Link
                      href={`${sourcePath(cfg)}/${o.sourceOrderId}`}
                      className="font-mono hover:underline"
                    >
                      {o.sourceOrderNumber}
                    </Link>
                  }
                />
              ) : null}
              {o.convertedOrderNumber ? (
                <Field
                  label="Converted to"
                  value={
                    <Link
                      href={`${cfg.convert?.targetPath ?? cfg.path}/${o.convertedOrderId}`}
                      className="font-mono hover:underline"
                    >
                      {o.convertedOrderNumber}
                    </Link>
                  }
                />
              ) : null}
              {o.notes ? (
                <Field
                  label="Notes"
                  value={<span className="whitespace-pre-wrap">{o.notes}</span>}
                />
              ) : null}
            </dl>
            <div className="mt-4 space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
              <Timeline label="Created" when={o.createdAt} />
              <Timeline label="Submitted" when={o.submittedAt} />
              <Timeline
                label={cfg.type === 'QUOTATION' ? 'Accepted' : 'Approved'}
                when={o.approvedAt}
              />
              <Timeline label="Closed" when={o.closedAt} />
            </div>
            <Button variant="link" size="sm" className="mt-2 px-0" asChild>
              <Link href={`/admin/audit-logs?entityId=${o.id}`}>View audit trail</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {pending ? (
        <Dialog open onOpenChange={(open) => !open && setPending(null)}>
          <DialogContent size="sm">
            <DialogHeader>
              <DialogTitle>
                {pending.label}: {o.documentNumber}
              </DialogTitle>
              <DialogDescription>
                {pending.action === 'approve'
                  ? `Approving opens the ${cfg.singular.toLowerCase()} for ${cfg.type === 'PURCHASE_ORDER' ? 'receiving and billing' : cfg.type === 'SALES_ORDER' ? 'invoicing' : 'conversion'}. Nothing is posted to the ledger.`
                  : pending.action === 'cancel'
                    ? 'A cancelled order keeps its number and cannot be reopened.'
                    : pending.action === 'close'
                      ? 'Closing stops further invoicing, receiving or billing against this order.'
                      : 'The status change is recorded in the audit trail.'}
              </DialogDescription>
            </DialogHeader>
            {pending.needsReason ? (
              <div className="space-y-1.5">
                <Label htmlFor="order-reason">Reason</Label>
                <Textarea
                  id="order-reason"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPending(null)}
                disabled={action.isPending}
              >
                Cancel
              </Button>
              <Button
                variant={
                  pending.action === 'cancel' || pending.action === 'reject'
                    ? 'destructive'
                    : 'default'
                }
                disabled={pending.needsReason && !reason.trim()}
                loading={action.isPending}
                onClick={() => void run(pending)}
              >
                {pending.label}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete draft ${o.documentNumber}?`}
        description="Drafts have no ledger effect. The number will not be reused."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(o.id);
            toast.success('Draft deleted.');
            router.push(cfg.path);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      {cfg.convert ? (
        <ConvertDialog cfg={cfg} order={o} open={converting} onOpenChange={setConverting} />
      ) : null}
      {cfg.fulfil ? (
        <FulfilDialog cfg={cfg} order={o} open={fulfilling} onOpenChange={setFulfilling} />
      ) : null}
      {cfg.tracksReceipts ? (
        <ReceiveDialog order={o} open={receiving} onOpenChange={setReceiving} />
      ) : null}
      {returnsCfg ? (
        <ReturnDialog cfg={cfg} order={o} open={returning} onOpenChange={setReturning} />
      ) : null}
    </>
  );
}

function sourcePath(cfg: OrderConfig): string {
  return cfg.type === 'SALES_ORDER'
    ? '/sales/quotations'
    : cfg.type === 'PURCHASE_ORDER'
      ? '/purchasing/requests'
      : cfg.path;
}

function qty(v: string): string {
  return v === '0.0000' ? '-' : trimAmount(v);
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function Timeline({ label, when }: { label: string; when: string | null }) {
  if (!when) return null;
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{formatDateTime(when)}</span>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

/** Quantity picker shared by invoicing, billing, receiving and returning. */
function QuantityTable({
  lines,
  remainingOf,
  quantities,
  onChange,
  currency,
  prices,
  onPriceChange,
}: {
  lines: OrderLine[];
  remainingOf: (l: OrderLine) => string;
  quantities: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  currency: string;
  prices?: Record<string, string>;
  onPriceChange?: (next: Record<string, string>) => void;
}) {
  const rows = lines.filter((l) => Money.of(remainingOf(l), currency).isPositive());
  return (
    <div className="rounded-md border" data-testid="quantity-table">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Line</TableHead>
            <TableHead className="w-24 text-right">Remaining</TableHead>
            {prices ? <TableHead className="w-32 text-right">Unit price</TableHead> : null}
            <TableHead className="w-32 text-right">Quantity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((l) => {
            const remaining = remainingOf(l);
            const over = Money.of(
              quantities[l.id] && /^\d{1,12}(\.\d{1,4})?$/.test(quantities[l.id]!)
                ? quantities[l.id]!
                : '0',
              currency,
            ).greaterThan(Money.of(remaining, currency));
            return (
              <TableRow key={l.id} className="hover:bg-transparent">
                <TableCell>
                  <span className="text-xs text-muted-foreground">{l.lineNumber}.</span>{' '}
                  {l.description}
                </TableCell>
                <TableCell className="tabular text-right">{trimAmount(remaining)}</TableCell>
                {prices && onPriceChange ? (
                  <TableCell>
                    <Input
                      inputMode="decimal"
                      className="tabular text-right"
                      aria-label={`Unit price for line ${l.lineNumber}`}
                      value={prices[l.id] ?? trimAmount(l.unitPrice)}
                      onChange={(e) => onPriceChange({ ...prices, [l.id]: e.target.value })}
                    />
                  </TableCell>
                ) : null}
                <TableCell>
                  <Input
                    inputMode="decimal"
                    className={
                      over ? 'tabular border-destructive text-right' : 'tabular text-right'
                    }
                    aria-label={`Quantity for line ${l.lineNumber}`}
                    value={quantities[l.id] ?? ''}
                    onChange={(e) => onChange({ ...quantities, [l.id]: e.target.value })}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={prices ? 4 : 3}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange(Object.fromEntries(rows.map((l) => [l.id, trimAmount(remainingOf(l))])))
                }
              >
                Fill remaining
              </Button>
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function selectedLines(
  quantities: Record<string, string>,
): Array<{ orderLineId: string; quantity: string }> {
  return Object.entries(quantities)
    .filter(([, q]) => /^\d{1,12}(\.\d{1,4})?$/.test(q.trim()) && Number(q) > 0)
    .map(([orderLineId, quantity]) => ({ orderLineId, quantity: quantity.trim() }));
}

function ConvertDialog({
  cfg,
  order,
  open,
  onOpenChange,
}: {
  cfg: OrderConfig;
  order: OrderDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const convert = useConvertOrder(cfg);
  const [vendorId, setVendorId] = React.useState<string | null>(order.vendorId);
  const [orderDate, setOrderDate] = React.useState(today());
  const needsVendor = cfg.convert!.needsVendor;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{cfg.convert!.label}</DialogTitle>
          <DialogDescription>
            The lines are copied as they stand; the new order starts as a draft and must be
            approved.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {needsVendor ? (
            <div className="space-y-1.5">
              <Label>Vendor</Label>
              <PartyCombobox
                cfg={cfg.subledger}
                value={vendorId}
                onChange={(id) => setVendorId(id)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="convert-date">Order date</Label>
            <Input
              id="convert-date"
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={needsVendor && !vendorId}
            loading={convert.isPending}
            onClick={async () => {
              try {
                const created = await convert.mutateAsync({
                  id: order.id,
                  vendorId: vendorId ?? undefined,
                  orderDate,
                });
                toast.success(`${created.documentNumber} created from ${order.documentNumber}.`);
                onOpenChange(false);
                router.push(`${cfg.convert!.targetPath}/${created.id}`);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            {cfg.convert!.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FulfilDialog({
  cfg,
  order,
  open,
  onOpenChange,
}: {
  cfg: OrderConfig;
  order: OrderDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const fulfil = useFulfilOrder(cfg);
  const isBill = cfg.type === 'PURCHASE_ORDER';
  const [documentDate, setDocumentDate] = React.useState(today());
  const [vendorInvoiceNumber, setVendorInvoiceNumber] = React.useState('');
  const [quantities, setQuantities] = React.useState<Record<string, string>>({});
  const [prices, setPrices] = React.useState<Record<string, string>>({});
  const lines = selectedLines(quantities).map((l) => ({
    ...l,
    unitPrice: isBill && prices[l.orderLineId] ? prices[l.orderLineId] : undefined,
  }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {cfg.fulfil!.label} from {order.documentNumber}
          </DialogTitle>
          <DialogDescription>
            {isBill
              ? 'A draft bill is raised for the chosen quantities and matched against the order and its receipts. Approve and post it from the bill.'
              : 'A draft invoice is raised for the chosen quantities. Approve and post it from the invoice to record the receivable.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="fulfil-date">Document date</Label>
            <Input
              id="fulfil-date"
              type="date"
              value={documentDate}
              onChange={(e) => setDocumentDate(e.target.value)}
            />
          </div>
          {isBill ? (
            <div className="space-y-1.5">
              <Label htmlFor="fulfil-vin">Vendor invoice no.</Label>
              <Input
                id="fulfil-vin"
                value={vendorInvoiceNumber}
                onChange={(e) => setVendorInvoiceNumber(e.target.value)}
                placeholder="Supplier's number"
              />
            </div>
          ) : null}
        </div>
        <QuantityTable
          lines={order.lines}
          remainingOf={(l) => l.remainingToBill}
          quantities={quantities}
          onChange={setQuantities}
          currency={order.currency}
          prices={isBill ? prices : undefined}
          onPriceChange={isBill ? setPrices : undefined}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={lines.length === 0}
            loading={fulfil.isPending}
            onClick={async () => {
              try {
                const result = await fulfil.mutateAsync({
                  id: order.id,
                  documentDate,
                  vendorInvoiceNumber: vendorInvoiceNumber || undefined,
                  lines,
                  idempotencyKey: crypto.randomUUID(),
                });
                toast.success(`${result.documentNumber} created as a draft.`);
                onOpenChange(false);
                router.push(`${cfg.fulfil!.documentPath}/${result.documentId}`);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            {cfg.fulfil!.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReceiveDialog({
  order,
  open,
  onOpenChange,
}: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const create = useCreateGoodsReceipt();
  const [receiptDate, setReceiptDate] = React.useState(today());
  const [reference, setReference] = React.useState('');
  const [quantities, setQuantities] = React.useState<Record<string, string>>({});
  const lines = selectedLines(quantities);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Receive goods for {order.documentNumber}</DialogTitle>
          <DialogDescription>
            Creates a draft goods receipt. Confirm it to update the received quantities and re-run
            the three-way match on any bills.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="gr-date">Receipt date</Label>
            <Input
              id="gr-date"
              type="date"
              value={receiptDate}
              onChange={(e) => setReceiptDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gr-ref">Delivery note</Label>
            <Input
              id="gr-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Supplier's delivery reference"
            />
          </div>
        </div>
        <QuantityTable
          lines={order.lines}
          remainingOf={(l) => l.remainingToReceive}
          quantities={quantities}
          onChange={setQuantities}
          currency={order.currency}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={lines.length === 0}
            loading={create.isPending}
            onClick={async () => {
              try {
                const created = await create.mutateAsync({
                  purchaseOrderId: order.id,
                  receiptDate,
                  reference: reference || undefined,
                  lines,
                  idempotencyKey: crypto.randomUUID(),
                });
                toast.success(`${created.documentNumber} created as a draft.`);
                onOpenChange(false);
                router.push(`${GOODS_RECEIPTS_PATH}/${created.id}`);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnDialog({
  cfg,
  order,
  open,
  onOpenChange,
}: {
  cfg: OrderConfig;
  order: OrderDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const returnsCfg = cfg.type === 'SALES_ORDER' ? SALES_RETURNS_CONFIG : PURCHASE_RETURNS_CONFIG;
  const create = useCreateReturn(returnsCfg);
  const [returnDate, setReturnDate] = React.useState(today());
  const [reason, setReason] = React.useState('');
  const [quantities, setQuantities] = React.useState<Record<string, string>>({});
  const lines = selectedLines(quantities);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {returnsCfg.singular} against {order.documentNumber}
          </DialogTitle>
          <DialogDescription>
            Quantities are capped by what was {cfg.type === 'SALES_ORDER' ? 'invoiced' : 'received'}
            . Approving and crediting the return raises a {returnsCfg.creditNoteLabel.toLowerCase()}{' '}
            at the order&apos;s net prices.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ret-date">Return date</Label>
            <Input
              id="ret-date"
              type="date"
              value={returnDate}
              onChange={(e) => setReturnDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ret-reason">Reason</Label>
            <Input
              id="ret-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Damaged, wrong item, ..."
            />
          </div>
        </div>
        <QuantityTable
          lines={order.lines}
          remainingOf={(l) => l.remainingToReturn}
          quantities={quantities}
          onChange={setQuantities}
          currency={order.currency}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={lines.length === 0}
            loading={create.isPending}
            onClick={async () => {
              try {
                const created = await create.mutateAsync({
                  orderId: order.id,
                  returnDate,
                  reason: reason || undefined,
                  lines,
                  idempotencyKey: crypto.randomUUID(),
                });
                toast.success(`${created.documentNumber} created as a draft.`);
                onOpenChange(false);
                router.push(`${returnsCfg.path}/${created.id}`);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
