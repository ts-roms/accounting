'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Ban, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Money } from '@accounting/money';
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
  useAllocatePayment,
  useDeletePayment,
  useDocuments,
  usePayment,
  usePostPayment,
  useVoidPayment,
} from '@/lib/api/subledger-hooks';
import type { SubledgerPaymentDetail } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { AttachmentsPanel } from '@/components/enterprise/attachments-panel';
import { Amount, today } from '@/components/accounting/primitives';
import { PaymentStatusBadge } from './badges';
import { AllocationEditor, safeMoney } from './document-detail';
import { partyOf } from './documents';

export function PaymentDetailPage({ cfg, id }: { cfg: SubledgerConfig; id: string }) {
  const router = useRouter();
  const { hasPermission } = useSession();
  const payment = usePayment(cfg, id);
  const post = usePostPayment(cfg);
  const voidPay = useVoidPayment(cfg);
  const remove = useDeletePayment(cfg);
  const [posting, setPosting] = React.useState(false);
  const [voiding, setVoiding] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [allocating, setAllocating] = React.useState(false);

  if (payment.isLoading || !payment.data) return <Skeleton className="h-96" />;
  const p = payment.data;
  const party = partyOf(cfg, p);
  const isDraft = p.status === 'DRAFT';
  const canEdit = isDraft && hasPermission(cfg.permissions.payCreate);
  const canPost = isDraft && hasPermission(cfg.permissions.payPost);
  const canVoid = p.status === 'POSTED' && hasPermission(cfg.permissions.payPost);
  const canAllocate =
    p.status === 'POSTED' &&
    p.paymentType === 'PAYMENT' &&
    p.unallocatedAmount !== '0.0000' &&
    hasPermission(cfg.permissions.payPost);
  const kind = p.paymentType === 'REFUND' ? 'Refund' : cfg.payment.singular;
  const cashLabel =
    (p.paymentType === 'REFUND') !== (cfg.side === 'AP') ? 'Paid from' : 'Deposited to';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{p.documentNumber}</span>
            <PaymentStatusBadge status={p.status} />
            <Badge variant="outline">{kind}</Badge>
          </span>
        }
        description={p.memo ?? `${kind} ${cfg.payment.direction} ${party.name}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={cfg.payment.path}>
                <ArrowLeft /> All {cfg.payment.plural.toLowerCase()}
              </Link>
            </Button>
            {canEdit ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`${cfg.payment.path}/${p.id}/edit`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                  <Trash2 /> Delete
                </Button>
              </>
            ) : null}
            {canVoid ? (
              <Button variant="outline" size="sm" onClick={() => setVoiding(true)}>
                <Ban /> Void
              </Button>
            ) : null}
            {canAllocate ? (
              <Button variant="outline" size="sm" onClick={() => setAllocating(true)}>
                Allocate on-account amount
              </Button>
            ) : null}
            {canPost ? (
              <Button size="sm" onClick={() => setPosting(true)}>
                <RotateCcw /> Post to ledger
              </Button>
            ) : null}
          </>
        }
      />

      {p.status === 'VOID' ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Voided</AlertTitle>
          <AlertDescription>{p.voidReason}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Allocations</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {p.allocations.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {p.paymentType === 'REFUND'
                  ? 'Refunds are not allocated to documents.'
                  : `Not allocated to any ${cfg.document.plural.toLowerCase()}; the full amount is on account.`}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Date</TableHead>
                    <TableHead>{cfg.document.singular}</TableHead>
                    <TableHead className="w-36 text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.allocations.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="whitespace-nowrap">{a.allocationDate}</TableCell>
                      <TableCell>
                        <Link
                          href={`${cfg.document.path}/${a.invoiceId ?? a.billId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {a.invoiceNumber ?? a.billNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Amount value={a.amount} currency={p.currency} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div className="grid grid-cols-3 gap-4 border-t p-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Amount</div>
                <Amount
                  value={p.amount}
                  currency={p.currency}
                  className="text-left font-semibold"
                />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Allocated
                </div>
                <Amount
                  value={p.allocatedAmount}
                  currency={p.currency}
                  className="text-left"
                  zeroAsDash
                />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  On account
                </div>
                <Amount
                  value={p.unallocatedAmount}
                  currency={p.currency}
                  className="text-left"
                  zeroAsDash
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{kind}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
              <Field
                label={cfg.party.singular}
                value={
                  <Link href={`${cfg.party.path}/${party.id}`} className="hover:underline">
                    {party.name}
                  </Link>
                }
              />
              <Field label="Date" value={p.paymentDate} />
              <Field label="Method" value={titleCase(p.method)} />
              <Field
                label={cashLabel}
                value={
                  <Link
                    href={`/accounting/general-ledger?accountId=${p.cashAccountId}`}
                    className="hover:underline"
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {p.cashAccountCode}
                    </span>{' '}
                    {p.cashAccountName}
                  </Link>
                }
              />
              <Field label="Reference" value={p.reference ?? '-'} />
              <Field label="Currency" value={p.currency} />
              {p.exchangeRate !== '1.00000000' ? (
                <Field
                  label="Exchange rate"
                  value={`1 ${p.currency} = ${Number(p.exchangeRate)} · bank ${p.baseAmount} · control ${p.controlBaseAmount}`}
                />
              ) : null}
              {p.journalNumber ? (
                <Field
                  label="Journal"
                  value={
                    <Link
                      href={`/accounting/journal-entries/${p.journalEntryId}`}
                      className="font-mono hover:underline"
                    >
                      {p.journalNumber}
                    </Link>
                  }
                />
              ) : null}
              {p.reversalJournalEntryId ? (
                <Field
                  label="Reversal"
                  value={
                    <Link
                      href={`/accounting/journal-entries/${p.reversalJournalEntryId}`}
                      className="font-mono hover:underline"
                    >
                      View reversing entry
                    </Link>
                  }
                />
              ) : null}
            </dl>
            <div className="mt-4 space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
              <Timeline label="Created" when={p.createdAt} />
              <Timeline label="Posted" when={p.postedAt} />
            </div>
            <Button variant="link" size="sm" className="mt-2 px-0" asChild>
              <Link href={`/admin/audit-logs?entityId=${p.id}`}>View audit trail</Link>
            </Button>
          </CardContent>
        </Card>
        <AttachmentsPanel
          entityType={cfg.side === 'AR' ? 'CUSTOMER_PAYMENT' : 'VENDOR_PAYMENT'}
          entityId={p.id}
        />
      </div>

      <ConfirmDialog
        open={posting}
        onOpenChange={setPosting}
        title={`Post ${p.documentNumber} to the ledger?`}
        description={
          cfg.side === 'AR'
            ? p.paymentType === 'REFUND'
              ? `Debits receivables and credits ${p.cashAccountName} for ${p.currency} ${p.amount}.`
              : `Debits ${p.cashAccountName} and credits the receivables control account for ${p.currency} ${p.amount}. Allocations settle the selected ${cfg.document.plural.toLowerCase()}.`
            : p.paymentType === 'REFUND'
              ? `Debits ${p.cashAccountName} and credits payables for ${p.currency} ${p.amount}.`
              : `Debits the payables control account and credits ${p.cashAccountName} for ${p.currency} ${p.amount}. Allocations settle the selected ${cfg.document.plural.toLowerCase()}.`
        }
        confirmLabel="Post"
        loading={post.isPending}
        onConfirm={async () => {
          try {
            await post.mutateAsync(p.id);
            toast.success(`${p.documentNumber} posted.`);
            setPosting(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete draft ${p.documentNumber}?`}
        description="Drafts have no ledger effect. The number will not be reused."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(p.id);
            toast.success('Draft deleted.');
            router.push(cfg.payment.path);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <VoidPaymentDialog
        open={voiding}
        onOpenChange={setVoiding}
        payment={p}
        loading={voidPay.isPending}
        onVoid={async (reason, reversalDate) => {
          try {
            await voidPay.mutateAsync({ id: p.id, reason, reversalDate });
            toast.success(`${p.documentNumber} voided.`);
            setVoiding(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      {canAllocate ? (
        <AllocateDialog cfg={cfg} open={allocating} onOpenChange={setAllocating} payment={p} />
      ) : null}
    </>
  );
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

function VoidPaymentDialog({
  open,
  onOpenChange,
  payment,
  loading,
  onVoid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: SubledgerPaymentDetail;
  loading: boolean;
  onVoid: (reason: string, reversalDate: string) => Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  const [reversalDate, setReversalDate] = React.useState(today());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Void {payment.documentNumber}</DialogTitle>
          <DialogDescription>
            Releases every allocation (the documents become open again) and posts a reversing
            journal entry on the date below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="void-pay-date">Reversal date</Label>
            <Input
              id="void-pay-date"
              type="date"
              value={reversalDate}
              onChange={(e) => setReversalDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="void-pay-reason">Reason</Label>
            <Textarea
              id="void-pay-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Recorded in the audit trail"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim()}
            loading={loading}
            onClick={() => void onVoid(reason.trim(), reversalDate)}
          >
            Void {payment.paymentType === 'REFUND' ? 'refund' : 'payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Apply the on-account remainder of a posted payment to open documents. */
function AllocateDialog({
  cfg,
  open,
  onOpenChange,
  payment,
}: {
  cfg: SubledgerConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: SubledgerPaymentDetail;
}) {
  const partyId = partyOf(cfg, payment).id ?? null;
  const targets = useDocuments(
    cfg,
    {
      partyId: partyId ?? undefined,
      openOnly: true,
      pageSize: 200,
      sortBy: 'dueDate',
      sortDir: 'asc',
    },
    open && Boolean(partyId),
  );
  const allocate = useAllocatePayment(cfg);
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const currency = payment.currency;
  const available = Money.parse(payment.unallocatedAmount, currency);
  const rows = (targets.data?.items ?? []).filter((t) => t.documentType !== 'CREDIT_NOTE');
  const allocated = Money.sum(
    Object.values(amounts).map((v) => safeMoney(v, currency)),
    currency,
  );
  const remaining = available.subtract(allocated);
  const invalid =
    remaining.isNegative() ||
    rows.some((r) =>
      safeMoney(amounts[r.id] ?? '0', currency).greaterThan(Money.parse(r.balance, currency)),
    );

  const submit = async () => {
    const allocations = Object.entries(amounts)
      .filter(([, v]) => safeMoney(v, currency).isPositive())
      .map(([documentId, amount]) => ({
        documentId,
        amount: safeMoney(amount, currency).toString(),
      }));
    try {
      await allocate.mutateAsync({ id: payment.id, allocations });
      toast.success('Allocated.');
      setAmounts({});
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Allocate {payment.documentNumber}</DialogTitle>
          <DialogDescription>
            Settles open documents from the on-account balance. No ledger entry is created - the
            cash was already recorded when the {cfg.payment.singular.toLowerCase()} was posted.
          </DialogDescription>
        </DialogHeader>
        <AllocationEditor
          cfg={cfg}
          rows={rows}
          currency={currency}
          amounts={amounts}
          onChange={setAmounts}
          available={available}
          isLoading={targets.isLoading}
        />
        <DialogFooter>
          <div className="mr-auto text-sm">
            Remaining on account:{' '}
            <Amount
              value={remaining.toString()}
              currency={currency}
              className={remaining.isNegative() ? 'inline text-critical' : 'inline'}
            />
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={invalid || allocated.isZero()}
            loading={allocate.isPending}
            onClick={() => void submit()}
          >
            Allocate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
