'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { FileText, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { AI_DOCUMENT_KINDS, AI_DOCUMENT_STATUSES, P, type AiDocumentKind } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  useAiDocument,
  useAiDocuments,
  useAiIntakeUpload,
  useDismissAiDocument,
  useDraftFromAiDocument,
  useUpdateAiDocument,
} from '@/lib/api/ai-hooks';
import type { AiDocument, AiExtractedLine } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { AP_CONFIG } from '@/lib/subledger/config';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { TaxCodeSelect } from '@/components/dimensions/pickers';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { Field } from '@/components/fixed-assets/shared';
import { AdvisoryNote, ConfidenceMeter, DocStatusBadge } from './shared';

const ALL = 'ALL';

export function AiIntakePage() {
  const router = useRouter();
  const table = useTableState({ pageSize: 25 });
  const [status, setStatus] = React.useState<string>(ALL);
  const [kind, setKind] = React.useState<string>(ALL);
  const [uploading, setUploading] = React.useState(false);
  const docs = useAiDocuments({
    ...table.query,
    status: status === ALL ? undefined : (status as AiDocument['status']),
    kind: kind === ALL ? undefined : (kind as AiDocumentKind),
  });
  const columns = React.useMemo<ColumnDef<AiDocument>[]>(
    () => [
      {
        id: 'file',
        header: 'Document',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <Link
              href={`/ai/intake/${row.original.id}`}
              className="font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.fileName}
            </Link>
            <div className="text-xs text-muted-foreground">
              {row.original.extracted.vendorName ?? 'Vendor not found'}
              {row.original.extracted.reference ? ` · ${row.original.extracted.reference}` : ''}
            </div>
          </div>
        ),
      },
      {
        id: 'kind',
        header: 'Kind',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.kind),
      },
      {
        id: 'date',
        header: 'Doc. date',
        enableSorting: false,
        cell: ({ row }) => row.original.extracted.documentDate ?? '-',
      },
      {
        id: 'total',
        header: () => <div className="text-right">Total</div>,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.extracted.total ? (
            <Amount
              value={row.original.extracted.total}
              currency={row.original.extracted.currency ?? undefined}
            />
          ) : (
            <span className="block text-right text-muted-foreground">-</span>
          ),
      },
      {
        id: 'confidence',
        header: 'Confidence',
        enableSorting: false,
        cell: ({ row }) => <ConfidenceMeter value={row.original.confidence} />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <DocStatusBadge status={row.original.status} />
            {row.original.draftNumber ? (
              <span className="font-mono text-xs">{row.original.draftNumber}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'created',
        header: 'Received',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Document intake"
        description="Drop supplier invoices and receipts here. The assistant reads them, suggests accounts and drafts the bill or claim for your review."
        actions={
          <Can permissions={[P['ai.use']]}>
            <Button onClick={() => setUploading(true)} data-testid="intake-upload">
              <Upload /> Upload document
            </Button>
          </Can>
        }
      />
      <AdvisoryNote />
      <DataTable
        columns={columns}
        data={docs.data}
        isLoading={docs.isLoading}
        isFetching={docs.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/ai/intake/${r.id}`)}
        emptyState={
          <EmptyState
            title="Nothing in the tray"
            description="Upload a PDF, image or text file of a supplier invoice or receipt."
          />
        }
        toolbar={
          <>
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
                <SelectItem value={ALL}>All statuses</SelectItem>
                {AI_DOCUMENT_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All kinds</SelectItem>
                {AI_DOCUMENT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {titleCase(k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <UploadDialog open={uploading} onOpenChange={setUploading} />
    </>
  );
}

function UploadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const upload = useAiIntakeUpload();
  const [file, setFile] = React.useState<File | null>(null);
  const [kind, setKind] = React.useState<string>('AUTO');
  const submit = async () => {
    if (!file) return;
    try {
      const doc = await upload.mutateAsync({ file, kind: kind === 'AUTO' ? undefined : kind });
      toast.success(
        doc.status === 'EXTRACTED'
          ? `Extracted ${doc.fileName} (${Math.round(Number(doc.confidence) * 100)}% confidence).`
          : `${doc.fileName} needs a review - some fields could not be read.`,
      );
      onOpenChange(false);
      setFile(null);
      router.push(`/ai/intake/${doc.id}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload a document</DialogTitle>
          <DialogDescription>
            PDF, PNG, JPEG or text up to 15 MB. Images are read by the model backend when one is
            configured; text and PDFs work offline.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="intake-file">File</Label>
            <Input
              id="intake-file"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,application/pdf,image/*,text/plain"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="intake-file"
            />
          </div>
          <div className="space-y-1">
            <Label>Treat as</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger data-testid="intake-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">Detect automatically</SelectItem>
                <SelectItem value="BILL">Vendor bill</SelectItem>
                <SelectItem value="EXPENSE_CLAIM">Expense receipt</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!file || upload.isPending} data-testid="intake-submit">
            <Sparkles /> {upload.isPending ? 'Reading...' : 'Extract'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ detail

type LineDraft = AiExtractedLine & { key: number };

export function AiDocumentPage({ id }: { id: string }) {
  const { hasPermission } = useSession();
  const doc = useAiDocument(id);
  const update = useUpdateAiDocument();
  const draft = useDraftFromAiDocument();
  const dismiss = useDismissAiDocument();
  const [dismissing, setDismissing] = React.useState(false);
  const [drafting, setDrafting] = React.useState<'BILL' | 'EXPENSE_CLAIM' | null>(null);
  const [vendorId, setVendorId] = React.useState<string | null>(null);
  const [fields, setFields] = React.useState({
    vendorName: '',
    reference: '',
    documentDate: '',
    dueDate: '',
    total: '',
  });
  const [lines, setLines] = React.useState<LineDraft[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const keyRef = React.useRef(0);

  React.useEffect(() => {
    if (!doc.data) return;
    const x = doc.data.extracted;
    setVendorId(doc.data.vendorId);
    setFields({
      vendorName: x.vendorName ?? '',
      reference: x.reference ?? '',
      documentDate: x.documentDate ?? '',
      dueDate: x.dueDate ?? '',
      total: x.total ?? '',
    });
    setLines(
      x.lines.map((l, i) => ({
        ...l,
        accountId: l.accountId ?? x.lineSuggestions?.[i]?.accountId ?? null,
        taxCodeId: l.taxCodeId ?? x.lineSuggestions?.[i]?.taxCodeId ?? null,
        key: keyRef.current++,
      })),
    );
    setDirty(false);
  }, [doc.data]);

  if (doc.isLoading || !doc.data) return <Skeleton className="h-64" />;
  const d = doc.data;
  const editable = d.status === 'EXTRACTED' || d.status === 'NEEDS_REVIEW';
  const canReview = hasPermission(P['ai.review']);
  const currency = d.extracted.currency ?? undefined;
  const lineTotal = lines.reduce(
    (sum, l) => sum + Number(l.quantity || '0') * Number(l.unitPrice || '0'),
    0,
  );

  const setLine = (key: number, patch: Partial<AiExtractedLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const save = async () => {
    try {
      await update.mutateAsync({
        id,
        vendorId,
        extracted: {
          vendorName: fields.vendorName || undefined,
          reference: fields.reference || undefined,
          documentDate: fields.documentDate || null,
          dueDate: fields.dueDate || null,
          currency: d.extracted.currency ?? null,
          subtotal: d.extracted.subtotal ?? null,
          taxAmount: d.extracted.taxAmount ?? null,
          total: fields.total || null,
          lines: lines.map(({ key: _k, ...l }) => ({
            description: l.description,
            quantity: l.quantity || '1',
            unitPrice: l.unitPrice || '0',
            accountId: l.accountId ?? null,
            taxCodeId: l.taxCodeId ?? null,
          })),
        },
      });
      toast.success('Corrections saved.');
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const createDraft = async () => {
    if (!drafting) return;
    try {
      if (dirty) await save();
      const result = await draft.mutateAsync({
        id,
        kind: drafting,
        vendorId: vendorId ?? undefined,
      });
      toast.success(`Draft ${result.draftNumber ?? ''} created - review and approve it as usual.`);
      for (const w of result.warnings ?? []) toast.warning(w);
      setDrafting(null);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <FileText className="h-5 w-5" /> {d.fileName} <DocStatusBadge status={d.status} />
          </span>
        }
        description={`Received ${formatDateTime(d.createdAt)}${d.createdByName ? ` by ${d.createdByName}` : ''} · read by ${d.provider === 'ANTHROPIC' ? `Claude (${d.model})` : 'built-in heuristics'}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {d.attachmentId ? (
              <Button variant="outline" asChild>
                <a
                  href={`/api/v1/attachments/file/${d.attachmentId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open file
                </a>
              </Button>
            ) : null}
            {editable && canReview ? (
              <>
                <Button
                  variant="outline"
                  onClick={save}
                  disabled={!dirty || update.isPending}
                  data-testid="intake-save"
                >
                  Save corrections
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setDismissing(true)}
                  data-testid="intake-dismiss"
                >
                  <Trash2 /> Dismiss
                </Button>
                {hasPermission(P['expense-claim.create']) ? (
                  <Button
                    variant="secondary"
                    onClick={() => setDrafting('EXPENSE_CLAIM')}
                    data-testid="intake-draft-claim"
                  >
                    <Plus /> Draft expense claim
                  </Button>
                ) : null}
                {hasPermission(P['bill.create']) ? (
                  <Button onClick={() => setDrafting('BILL')} data-testid="intake-draft-bill">
                    <Plus /> Draft bill
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        }
      />
      <AdvisoryNote />
      {d.error ? (
        <Card className="border-warning">
          <CardContent className="p-3 text-sm">{d.error}</CardContent>
        </Card>
      ) : null}
      {d.status === 'DRAFTED' ? (
        <Card className="border-success">
          <CardContent className="p-3 text-sm" data-testid="intake-drafted">
            A draft was created from this document:{' '}
            <Link
              className="font-mono underline"
              href={
                d.draftBillId
                  ? `/purchasing/bills/${d.draftBillId}`
                  : `/budgeting/expense-claims/${d.draftExpenseClaimId}`
              }
            >
              {d.draftNumber}
            </Link>
            . It still needs the usual approval and posting.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Extracted fields</h2>
              <ConfidenceMeter value={d.confidence} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label>Vendor on document</Label>
                <Input
                  value={fields.vendorName}
                  disabled={!editable || !canReview}
                  onChange={(e) => {
                    setFields((f) => ({ ...f, vendorName: e.target.value }));
                    setDirty(true);
                  }}
                  data-testid="intake-vendor-name"
                />
              </div>
              <div className="space-y-1">
                <Label>Matched vendor</Label>
                <PartyCombobox
                  cfg={AP_CONFIG}
                  value={vendorId}
                  disabled={!editable || !canReview}
                  onChange={(vid) => {
                    setVendorId(vid);
                    setDirty(true);
                  }}
                />
                {!vendorId ? (
                  <p className="text-xs text-warning">
                    No vendor matched - pick one before drafting a bill.
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label>Reference / invoice no.</Label>
                <Input
                  value={fields.reference}
                  disabled={!editable || !canReview}
                  onChange={(e) => {
                    setFields((f) => ({ ...f, reference: e.target.value }));
                    setDirty(true);
                  }}
                  data-testid="intake-reference"
                />
              </div>
              <div className="space-y-1">
                <Label>Total on document</Label>
                <Input
                  inputMode="decimal"
                  value={fields.total}
                  disabled={!editable || !canReview}
                  onChange={(e) => {
                    setFields((f) => ({ ...f, total: e.target.value }));
                    setDirty(true);
                  }}
                  data-testid="intake-total"
                />
              </div>
              <div className="space-y-1">
                <Label>Document date</Label>
                <Input
                  type="date"
                  value={fields.documentDate}
                  disabled={!editable || !canReview}
                  onChange={(e) => {
                    setFields((f) => ({ ...f, documentDate: e.target.value }));
                    setDirty(true);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>Due date</Label>
                <Input
                  type="date"
                  value={fields.dueDate}
                  disabled={!editable || !canReview}
                  onChange={(e) => {
                    setFields((f) => ({ ...f, dueDate: e.target.value }));
                    setDirty(true);
                  }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <h2 className="font-medium">Lines</h2>
              {editable && canReview ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setLines((ls) => [
                      ...ls,
                      {
                        description: '',
                        quantity: '1',
                        unitPrice: '',
                        accountId: null,
                        taxCodeId: null,
                        key: keyRef.current++,
                      },
                    ]);
                    setDirty(true);
                  }}
                  data-testid="intake-add-line"
                >
                  <Plus /> Add line
                </Button>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <Table className="min-w-[56rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="w-20 text-right">Qty</TableHead>
                    <TableHead className="w-32 text-right">Unit price</TableHead>
                    <TableHead className="w-64">Account (suggested)</TableHead>
                    <TableHead className="w-40">Tax</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l, i) => {
                    const hint = d.extracted.lineSuggestions?.[i];
                    return (
                      <TableRow key={l.key} data-testid="intake-line">
                        <TableCell>
                          <Input
                            value={l.description}
                            disabled={!editable || !canReview}
                            onChange={(e) => setLine(l.key, { description: e.target.value })}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            inputMode="decimal"
                            className="text-right"
                            value={l.quantity}
                            disabled={!editable || !canReview}
                            onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            inputMode="decimal"
                            className="text-right"
                            value={l.unitPrice}
                            disabled={!editable || !canReview}
                            onChange={(e) => setLine(l.key, { unitPrice: e.target.value })}
                          />
                        </TableCell>
                        <TableCell>
                          <AccountCombobox
                            value={l.accountId}
                            disabled={!editable || !canReview}
                            onChange={(aid) => setLine(l.key, { accountId: aid })}
                          />
                          {hint && hint.accountId === l.accountId ? (
                            <p
                              className="mt-1 text-xs text-muted-foreground"
                              data-testid="intake-line-hint"
                            >
                              <Sparkles className="mr-1 inline h-3 w-3" />
                              {Math.round(hint.confidence * 100)}% · {hint.rationale}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <TaxCodeSelect
                            side="PURCHASES"
                            kind="SALES_TAX"
                            value={l.taxCodeId}
                            disabled={!editable || !canReview}
                            onChange={(tid) => setLine(l.key, { taxCodeId: tid })}
                          />
                        </TableCell>
                        <TableCell>
                          {editable && canReview ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Remove line"
                              onClick={() => {
                                setLines((ls) => ls.filter((x) => x.key !== l.key));
                                setDirty(true);
                              }}
                            >
                              <Trash2 />
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {lines.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                        No lines were read. Add one (or leave the total and a single line will be
                        drafted).
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap justify-end gap-6 text-sm">
              <span className="text-muted-foreground">Lines total</span>
              <Amount value={lineTotal.toFixed(4)} currency={currency} className="font-medium" />
              {fields.total && Math.abs(Number(fields.total) - lineTotal) > 0.005 ? (
                <Badge variant="warning">differs from document total {fields.total}</Badge>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <h2 className="font-medium">Summary</h2>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
              <Field label="Kind" value={titleCase(d.kind)} />
              <Field label="Currency" value={d.extracted.currency ?? '-'} />
              <Field label="Subtotal" value={d.extracted.subtotal ?? '-'} />
              <Field label="Tax" value={d.extracted.taxAmount ?? '-'} />
              <Field label="TIN" value={d.extracted.vendorTaxId ?? '-'} />
              <Field label="Reviewed" value={d.reviewedAt ? formatDateTime(d.reviewedAt) : '-'} />
            </dl>
            {d.sourceText ? (
              <div className="space-y-1">
                <Label>Text read from the file</Label>
                <Textarea readOnly rows={14} value={d.sourceText} className="font-mono text-xs" />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No text layer - the fields above came from the image (or were typed in).
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={dismissing}
        onOpenChange={setDismissing}
        title="Dismiss this document?"
        description="It stays in the tray as dismissed and nothing is drafted."
        confirmLabel="Dismiss"
        destructive
        loading={dismiss.isPending}
        onConfirm={async () => {
          try {
            await dismiss.mutateAsync({ id });
            toast.success('Dismissed.');
            setDismissing(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ConfirmDialog
        open={Boolean(drafting)}
        onOpenChange={(o) => !o && setDrafting(null)}
        title={drafting === 'BILL' ? 'Draft a vendor bill?' : 'Draft an expense claim?'}
        description={
          drafting === 'BILL'
            ? `A DRAFT bill dated ${fields.documentDate || today()} for ${lines.length || 1} line(s) will be created for the matched vendor. Approval and posting stay manual.`
            : `A DRAFT expense claim dated ${fields.documentDate || today()} will be created for you. Submission and approval stay manual.`
        }
        confirmLabel={drafting === 'BILL' ? 'Create draft bill' : 'Create draft claim'}
        loading={draft.isPending || update.isPending}
        onConfirm={createDraft}
      />
    </>
  );
}
