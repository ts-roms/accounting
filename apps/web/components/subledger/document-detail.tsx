'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Ban, Check, Pencil, RotateCcw, Trash2 } from 'lucide-react';
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  StepTimeline,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useApplyCreditNote,
  useDeleteDocument,
  useDocument,
  useDocumentAction,
  useDocuments,
  useUpdateCollection,
  useVoidDocument,
  type DocumentAction,
} from '@/lib/api/subledger-hooks';
import type { DocumentWarning, SubledgerDocument, SubledgerDocumentDetail } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { formatDateTime, titleCase } from '@/lib/format';
import { ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { DelegatedAuthorityNotice } from '@/components/delegations/delegated-authority-notice';
import {
  APPROVAL_STEPS,
  OperationDialog,
  POSTING_STEPS,
} from '@/components/accounting/operation-dialog';
import { documentTimeline } from '@/components/accounting/timelines';
import { AttachmentsPanel } from '@/components/enterprise/attachments-panel';
import { RecordLinksPanel } from '@/components/integrations/record-links-panel';
import { HistoryPanel } from '@/components/enterprise/history-panel';
import { DocumentJournalsPanel } from '@/components/reporting/trace-panel';
import { Amount, today } from '@/components/accounting/primitives';
import { MatchCard } from '@/components/orders/match-card';
import { DocumentStatusBadge } from './badges';
import { partyOf } from './documents';
import { InvoiceArActions, InvoiceArBadges } from '@/components/receivables/ar-panels';
import { BillApActions, BillApBadges } from '@/components/payables/ap-panels';

export function DocumentDetailPage({ cfg, id }: { cfg: SubledgerConfig; id: string }) {
  const router = useRouter();
  const { hasPermission, hasAuthority } = useSession();
  const document = useDocument(cfg, id);
  const action = useDocumentAction(cfg);
  const voidDoc = useVoidDocument(cfg);
  const remove = useDeleteDocument(cfg);
  const [pending, setPending] = React.useState<DocumentAction | null>(null);
  const [voiding, setVoiding] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [applying, setApplying] = React.useState(false);
  const [warnings, setWarnings] = React.useState<DocumentWarning[]>([]);

  if (document.isLoading || !document.data) return <Skeleton className="h-96" />;
  const d = document.data;
  const party = partyOf(cfg, d);
  const isDraft = d.status === 'DRAFT';
  const canEdit = isDraft && hasPermission(cfg.permissions.docCreate);
  // Approval may be held natively or through an active delegation (the API enforces scope and limits).
  const canApprove =
    (isDraft || d.status === 'SUBMITTED') && hasAuthority(cfg.permissions.docApprove);
  const canPost =
    d.status === 'APPROVED' &&
    d.accountingStatus === 'UNPOSTED' &&
    hasPermission(cfg.permissions.docPost);
  const settled = d.allocatedAmount !== '0.0000';
  const canVoid = d.status !== 'VOID' && !settled && hasPermission(cfg.permissions.docVoid);
  const isCreditNote = d.documentType === 'CREDIT_NOTE';
  const canApply =
    isCreditNote &&
    d.accountingStatus === 'POSTED' &&
    d.balance !== '0.0000' &&
    d.status !== 'VOID' &&
    hasPermission(cfg.permissions.payPost);
  const typeLabel =
    d.documentType === 'INVOICE'
      ? cfg.document.singular
      : d.documentType === 'CREDIT_NOTE'
        ? cfg.document.creditNoteLabel
        : cfg.document.debitNoteLabel;

  // Throws on failure: the operation dialog maps the error to the failing check.
  const run = async (act: DocumentAction) => {
    const result = await action.mutateAsync({ id: d.id, action: act });
    setWarnings(result.warnings ?? []);
    toast.success(
      `${d.documentNumber} ${act === 'approve' ? 'approved' : 'posted to the ledger'}.`,
    );
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{d.documentNumber}</span>
            <DocumentStatusBadge status={d.status} accountingStatus={d.accountingStatus} />
            <Badge variant="outline">{typeLabel}</Badge>
            {cfg.side === 'AR' ? <InvoiceArBadges document={d} /> : <BillApBadges document={d} />}
          </span>
        }
        description={d.description ?? `${typeLabel} for ${party.name}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={cfg.document.path}>
                <ArrowLeft /> All {cfg.document.plural.toLowerCase()}
              </Link>
            </Button>
            {canEdit ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`${cfg.document.path}/${d.id}/edit`}>
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
            {canApply ? (
              <Button variant="outline" size="sm" onClick={() => setApplying(true)}>
                Apply to {cfg.document.plural.toLowerCase()}
              </Button>
            ) : null}
            {cfg.side === 'AR' ? <InvoiceArActions document={d} /> : <BillApActions document={d} />}
            {canApprove ? (
              <Button size="sm" onClick={() => setPending('approve')}>
                <Check /> Approve
              </Button>
            ) : null}
            {canPost ? (
              <Button size="sm" onClick={() => setPending('post')}>
                <RotateCcw /> Post to ledger
              </Button>
            ) : null}
          </>
        }
      />

      {d.status === 'VOID' ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Voided {d.voidedAt ? formatDateTime(d.voidedAt) : ''}</AlertTitle>
          <AlertDescription>{d.voidReason}</AlertDescription>
        </Alert>
      ) : null}
      {isDraft ? (
        <DelegatedAuthorityNotice
          permission={cfg.permissions.docApprove}
          amount={d.total}
          currency={d.currency}
        />
      ) : null}
      <WarningsAlert warnings={warnings.length ? warnings : (d.warnings ?? [])} />

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
                    <TableHead>Account</TableHead>
                    <TableHead className="w-24 text-right">Qty</TableHead>
                    <TableHead className="w-32 text-right">Unit price</TableHead>
                    <TableHead className="w-20 text-right">Disc %</TableHead>
                    <TableHead className="w-36 text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {l.lineNumber}
                      </TableCell>
                      <TableCell>
                        {l.description}
                        {l.productId ? (
                          <div className="text-xs text-muted-foreground">
                            Stock item
                            {l.lotNumber ? ` - lot ${l.lotNumber}` : ''}
                            {l.serialNumbers.length ? ` - ${l.serialNumbers.length} serial(s)` : ''}
                            {l.costAmount ? ` - cost ${l.costAmount}` : ''}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/accounting/general-ledger?accountId=${l.accountId}`}
                          className="hover:underline"
                        >
                          <span className="font-mono text-xs text-muted-foreground">
                            {l.accountCode}
                          </span>{' '}
                          {l.accountName}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular text-right">{trimQty(l.quantity)}</TableCell>
                      <TableCell>
                        <Amount value={l.unitPrice} currency={d.currency} />
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {l.discountPercent === '0.0000' ? '-' : trimQty(l.discountPercent)}
                      </TableCell>
                      <TableCell>
                        <Amount value={l.amount} currency={d.currency} />
                        {l.taxCodeId || l.withholdingTaxCodeId ? (
                          <div className="text-right text-[11px] text-muted-foreground">
                            {l.taxCodeId ? `tax ${trimQty(l.taxRate)}% = ${l.taxAmount}` : ''}
                            {l.withholdingTaxCodeId
                              ? ` wht ${trimQty(l.withholdingRate)}% = ${l.withholdingAmount}`
                              : ''}
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  {d.taxTotal !== '0.0000' || d.withholdingTotal !== '0.0000' ? (
                    <>
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={6}
                          className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                        >
                          Subtotal
                        </TableCell>
                        <TableCell>
                          <Amount value={d.subtotal} currency={d.currency} />
                        </TableCell>
                      </TableRow>
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={6}
                          className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                        >
                          Tax
                        </TableCell>
                        <TableCell>
                          <Amount value={d.taxTotal} currency={d.currency} zeroAsDash />
                        </TableCell>
                      </TableRow>
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={6}
                          className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                        >
                          Withholding
                        </TableCell>
                        <TableCell>
                          <Amount
                            value={d.withholdingTotal === '0.0000' ? '0' : `-${d.withholdingTotal}`}
                            currency={d.currency}
                            zeroAsDash
                          />
                        </TableCell>
                      </TableRow>
                    </>
                  ) : null}
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={6}
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      Total ({d.currency})
                    </TableCell>
                    <TableCell>
                      <Amount value={d.total} currency={d.currency} className="font-semibold" />
                    </TableCell>
                  </TableRow>
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={6}
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {isCreditNote ? 'Applied' : 'Settled'}
                    </TableCell>
                    <TableCell>
                      <Amount value={d.allocatedAmount} currency={d.currency} zeroAsDash />
                    </TableCell>
                  </TableRow>
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={6}
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {isCreditNote ? 'Unapplied' : 'Balance due'}
                    </TableCell>
                    <TableCell>
                      <Amount
                        value={d.balance}
                        currency={d.currency}
                        className="font-semibold"
                        zeroAsDash
                      />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{isCreditNote ? 'Applied to' : 'Settlements'}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {d.allocations.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {isCreditNote
                    ? 'Not yet applied to any document.'
                    : `No ${cfg.payment.plural.toLowerCase()} or credit notes applied yet.`}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Date</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead className="w-36 text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.allocations.map((a) => {
                      const target = isCreditNote
                        ? {
                            href: `${cfg.document.path}/${a.invoiceId ?? a.billId}`,
                            label: a.invoiceNumber ?? a.billNumber,
                          }
                        : a.paymentId
                          ? { href: `${cfg.payment.path}/${a.paymentId}`, label: a.paymentNumber }
                          : {
                              href: `${cfg.document.path}/${a.creditNoteId}`,
                              label: a.creditNoteNumber,
                            };
                      return (
                        <TableRow key={a.id}>
                          <TableCell className="whitespace-nowrap">{a.allocationDate}</TableCell>
                          <TableCell>
                            <Link href={target.href} className="font-mono text-xs hover:underline">
                              {target.label}
                            </Link>
                            {!isCreditNote && a.creditNoteId ? (
                              <span className="ml-2 text-xs text-muted-foreground">
                                credit note
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Amount value={a.amount} currency={d.currency} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Document</CardTitle>
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
                <Field label="Date" value={d.documentDate} />
                <Field
                  label="Due"
                  value={
                    <span>
                      {d.dueDate}
                      {d.daysOverdue > 0 ? (
                        <span className="ml-1 text-xs text-critical">
                          {d.daysOverdue} days overdue
                        </span>
                      ) : null}
                    </span>
                  }
                />
                <Field label="Reference" value={d.reference ?? '-'} />
                <Field label="Currency" value={d.currency} />
                {d.exchangeRate !== '1.00000000' ? (
                  <Field
                    label="Exchange rate"
                    value={`1 ${d.currency} = ${Number(d.exchangeRate)} · base ${d.baseTotal}`}
                  />
                ) : null}
                {d.salesOrderId ? (
                  <Field
                    label="Sales order"
                    value={
                      <Link href={`/sales/orders/${d.salesOrderId}`} className="hover:underline">
                        View order
                      </Link>
                    }
                  />
                ) : null}
                {d.purchaseOrderId ? (
                  <Field
                    label="Purchase order"
                    value={
                      <Link
                        href={`/purchasing/orders/${d.purchaseOrderId}`}
                        className="hover:underline"
                      >
                        View order
                      </Link>
                    }
                  />
                ) : null}
                {cfg.side === 'AP' ? (
                  <Field label="Vendor inv." value={d.vendorInvoiceNumber ?? '-'} />
                ) : null}
                <Field label="Accounting" value={titleCase(d.accountingStatus)} />
                {d.journalNumber ? (
                  <Field
                    label="Journal"
                    value={
                      <Link
                        href={`/accounting/journal-entries/${d.journalEntryId}`}
                        className="font-mono hover:underline"
                      >
                        {d.journalNumber}
                      </Link>
                    }
                  />
                ) : null}
                {d.reversalJournalEntryId ? (
                  <Field
                    label="Reversal"
                    value={
                      <Link
                        href={`/accounting/journal-entries/${d.reversalJournalEntryId}`}
                        className="font-mono hover:underline"
                      >
                        View reversing entry
                      </Link>
                    }
                  />
                ) : null}
              </dl>
              <div className="mt-4 border-t pt-3">
                <div className="type-label mb-2">Lifecycle</div>
                <StepTimeline steps={documentTimeline(d)} />
              </div>
              <Button variant="link" size="sm" className="mt-2 px-0" asChild>
                <Link href={`/admin/audit-logs?entityId=${d.id}`}>View audit trail</Link>
              </Button>
            </CardContent>
          </Card>
          {cfg.side === 'AP' ? <MatchCard cfg={cfg} bill={d} /> : null}
          {!isCreditNote && d.status !== 'VOID' && d.status !== 'DRAFT' ? (
            <FollowUpCard cfg={cfg} document={d} />
          ) : null}
          <DocumentJournalsPanel sourceId={d.id} />
          <RecordLinksPanel
            entityType={cfg.side === 'AR' ? 'invoices' : 'bills'}
            internalId={d.id}
            showTargets={d.accountingStatus !== 'UNPOSTED'}
          />
          <AttachmentsPanel entityType={cfg.side === 'AR' ? 'INVOICE' : 'BILL'} entityId={d.id} />
          <HistoryPanel entityType={cfg.side === 'AR' ? 'Invoice' : 'VendorBill'} entityId={d.id} />
        </div>
      </div>

      <OperationDialog
        open={pending === 'approve'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Approve ${d.documentNumber}`}
        description="Approval locks the lines. The document has no ledger effect until it is posted."
        confirmLabel="Approve"
        loadingLabel="Approving..."
        resultLabel="Approved"
        steps={APPROVAL_STEPS}
        run={() => run('approve')}
      />
      <OperationDialog
        open={pending === 'post'}
        onOpenChange={(o) => !o && setPending(null)}
        title={`Post ${d.documentNumber} to the ledger`}
        description={
          cfg.side === 'AR'
            ? `Debits the receivables control account and credits each line account for ${d.currency} ${d.total}. Posted entries can only be reversed.`
            : `Debits each line account and credits the payables control account for ${d.currency} ${d.total}. Posted entries can only be reversed.`
        }
        confirmLabel="Post"
        loadingLabel="Posting..."
        resultLabel="Posted"
        steps={POSTING_STEPS}
        run={() => run('post')}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete draft ${d.documentNumber}?`}
        description="Drafts have no ledger effect. The document number will not be reused."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(d.id);
            toast.success('Draft deleted.');
            router.push(cfg.document.path);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <VoidDialog
        open={voiding}
        onOpenChange={setVoiding}
        document={d}
        loading={voidDoc.isPending}
        onVoid={async (reason, reversalDate) => {
          try {
            await voidDoc.mutateAsync({ id: d.id, reason, reversalDate });
            toast.success(`${d.documentNumber} voided.`);
            setVoiding(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      {canApply ? (
        <ApplyCreditNoteDialog
          cfg={cfg}
          open={applying}
          onOpenChange={setApplying}
          creditNote={d}
        />
      ) : null}
    </>
  );
}

function trimQty(q: string): string {
  return q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export function WarningsAlert({ warnings }: { warnings: DocumentWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertTriangle />
      <AlertTitle>Review before continuing</AlertTitle>
      <AlertDescription>
        {warnings.map((w, i) => (
          <div key={`${w.code}-${i}`}>{w.message}</div>
        ))}
      </AlertDescription>
    </Alert>
  );
}

function VoidDialog({
  open,
  onOpenChange,
  document,
  loading,
  onVoid,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: SubledgerDocument;
  loading: boolean;
  onVoid: (reason: string, reversalDate?: string) => Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  const [reversalDate, setReversalDate] = React.useState(today());
  const posted = document.accountingStatus === 'POSTED';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Void {document.documentNumber}</DialogTitle>
          <DialogDescription>
            {posted
              ? 'The document is posted, so a reversing journal entry will be created on the date below. The original entry stays in the ledger.'
              : 'The draft is marked void and keeps its number. Nothing is posted.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {posted ? (
            <div className="space-y-1.5">
              <Label htmlFor="void-date">Reversal date</Label>
              <Input
                id="void-date"
                type="date"
                value={reversalDate}
                onChange={(e) => setReversalDate(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="void-reason">Reason</Label>
            <Textarea
              id="void-reason"
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
            onClick={() => void onVoid(reason.trim(), posted ? reversalDate : undefined)}
          >
            Void document
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Promised-payment (AR) or scheduled-payment (AP) follow-up on an open document. */
function FollowUpCard({
  cfg,
  document,
}: {
  cfg: SubledgerConfig;
  document: SubledgerDocumentDetail;
}) {
  const update = useUpdateCollection(cfg);
  const { hasPermission } = useSession();
  const isAr = cfg.side === 'AR';
  const [date, setDate] = React.useState(
    (isAr ? document.promisedPaymentDate : document.scheduledPaymentDate) ?? '',
  );
  const [notes, setNotes] = React.useState(document.collectionNotes ?? '');
  const canEdit = hasPermission(cfg.permissions.docCreate);
  const save = async () => {
    try {
      await update.mutateAsync(
        isAr
          ? { id: document.id, promisedPaymentDate: date || null, collectionNotes: notes }
          : { id: document.id, scheduledPaymentDate: date || null },
      );
      toast.success('Saved.');
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{isAr ? 'Collection' : 'Payment schedule'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="followup-date">
            {isAr ? 'Promised payment date' : 'Scheduled payment date'}
          </Label>
          <Input
            id="followup-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={!canEdit}
          />
        </div>
        {isAr ? (
          <div className="space-y-1.5">
            <Label htmlFor="followup-notes">Collection notes</Label>
            <Textarea
              id="followup-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={!canEdit}
            />
          </div>
        ) : null}
        {canEdit ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void save()}
            loading={update.isPending}
          >
            Save
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Apply an unapplied, posted credit note against the same party's open documents. */
function ApplyCreditNoteDialog({
  cfg,
  open,
  onOpenChange,
  creditNote,
}: {
  cfg: SubledgerConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creditNote: SubledgerDocumentDetail;
}) {
  const partyId = partyOf(cfg, creditNote).id ?? null;
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
  const apply = useApplyCreditNote(cfg);
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const currency = creditNote.currency;
  const available = Money.parse(creditNote.balance, currency);
  const rows = (targets.data?.items ?? []).filter(
    (t) => t.documentType !== 'CREDIT_NOTE' && t.id !== creditNote.id,
  );
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
      await apply.mutateAsync({ id: creditNote.id, allocations });
      toast.success('Credit note applied.');
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
          <DialogTitle>Apply {creditNote.documentNumber}</DialogTitle>
          <DialogDescription>
            Applying a credit note settles open documents without touching the ledger - both were
            already posted.
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
            Remaining credit:{' '}
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
            loading={apply.isPending}
            onClick={() => void submit()}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function safeMoney(value: string, currency: string): Money {
  try {
    return Money.isValidDecimalString(value) ? Money.parse(value, currency) : Money.zero(currency);
  } catch {
    return Money.zero(currency);
  }
}

/** Per-document allocation table shared by receipts, payments and credit-note application. */
export function AllocationEditor({
  cfg,
  rows,
  currency,
  amounts,
  onChange,
  available,
  isLoading,
  disabled,
}: {
  cfg: SubledgerConfig;
  rows: SubledgerDocument[];
  currency: string;
  amounts: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  available: Money;
  isLoading?: boolean;
  disabled?: boolean;
}) {
  const set = (id: string, value: string) => onChange({ ...amounts, [id]: value });
  const allocated = Money.sum(
    Object.values(amounts).map((v) => safeMoney(v, currency)),
    currency,
  );
  const fillOldestFirst = () => {
    let left = available;
    const next: Record<string, string> = {};
    for (const r of rows) {
      if (!left.isPositive()) break;
      const bal = Money.parse(r.balance, currency);
      const take = bal.lessThan(left) ? bal : left;
      next[r.id] = trimAmount(take.toString());
      left = left.subtract(take);
    }
    onChange(next);
  };

  if (isLoading) return <Skeleton className="h-32" />;
  if (rows.length === 0)
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No open {cfg.document.plural.toLowerCase()} to allocate against. The amount stays on
        account.
      </p>
    );
  return (
    <div className="rounded-md border" data-testid="allocation-editor">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Document</TableHead>
            <TableHead>Due</TableHead>
            <TableHead className="w-32 text-right">Balance</TableHead>
            <TableHead className="w-40 text-right">Allocate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const bal = Money.parse(r.balance, currency);
            const value = amounts[r.id] ?? '';
            const over = safeMoney(value, currency).greaterThan(bal);
            return (
              <TableRow key={r.id} className="hover:bg-transparent">
                <TableCell>
                  <span className="font-mono text-xs">{r.documentNumber}</span>
                  {r.documentType !== 'INVOICE' ? (
                    <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                      {titleCase(r.documentType)}
                    </span>
                  ) : null}
                  {r.reference ? (
                    <div className="text-xs text-muted-foreground">{r.reference}</div>
                  ) : null}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {r.dueDate}
                  {r.daysOverdue > 0 ? (
                    <span className="ml-1 text-xs text-critical">+{r.daysOverdue}d</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Amount value={r.balance} currency={currency} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Input
                      inputMode="decimal"
                      aria-label={`Allocate to ${r.documentNumber}`}
                      className={over ? 'tabular border-critical text-right' : 'tabular text-right'}
                      value={value}
                      disabled={disabled}
                      onChange={(e) => set(r.id, e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="px-1 text-xs"
                      disabled={disabled}
                      onClick={() => set(r.id, trimAmount(r.balance))}
                    >
                      Full
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={2}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || !available.isPositive()}
                onClick={fillOldestFirst}
              >
                Auto-allocate oldest first
              </Button>
            </TableCell>
            <TableCell className="text-right text-xs uppercase tracking-wide text-muted-foreground">
              Allocated
            </TableCell>
            <TableCell>
              <Amount value={allocated.toString()} currency={currency} className="font-semibold" />
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

export function trimAmount(amount: string): string {
  if (!amount.includes('.')) return amount;
  const t = amount.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}
