'use client';
import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Pencil,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { AttachmentsPanel } from '@/components/enterprise/attachments-panel';
import { P, type JournalStatus } from '@accounting/types';
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
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useDeleteJournalEntry,
  useJournalAction,
  useJournalEntry,
  useRejectJournalEntry,
  useReverseJournalEntry,
  type JournalAction,
} from '@/lib/api/accounting-hooks';
import type { JournalEntryDetail, SodConflict } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { Amount, JournalStatusBadge, today } from '@/components/accounting/primitives';

const ACTION_LABEL: Record<
  JournalAction,
  { label: string; verb: string; permission: keyof typeof P }
> = {
  submit: { label: 'Submit for approval', verb: 'submitted', permission: 'journal.submit' },
  approve: { label: 'Approve', verb: 'approved', permission: 'journal.approve' },
  post: { label: 'Post to ledger', verb: 'posted', permission: 'journal.post' },
};

const NEXT_ACTION: Partial<Record<JournalStatus, JournalAction>> = {
  DRAFT: 'submit',
  REJECTED: 'submit',
  SUBMITTED: 'approve',
  APPROVED: 'post',
};

export default function JournalEntryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { hasPermission, me } = useSession();
  const entry = useJournalEntry(params.id);
  const action = useJournalAction();
  const reject = useRejectJournalEntry();
  const reverse = useReverseJournalEntry();
  const remove = useDeleteJournalEntry();
  const [pending, setPending] = React.useState<JournalAction | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reversing, setReversing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [warnings, setWarnings] = React.useState<SodConflict[]>([]);

  if (entry.isLoading || !entry.data) return <Skeleton className="h-96" />;
  const e = entry.data;
  const editable = e.status === 'DRAFT' || e.status === 'REJECTED';
  const next = NEXT_ACTION[e.status];
  const nextAllowed = next ? hasPermission(P[ACTION_LABEL[next].permission]) : false;
  const canReject =
    (e.status === 'SUBMITTED' || e.status === 'APPROVED') && hasPermission(P['journal.approve']);
  const canReverse =
    (e.status === 'POSTED' || e.status === 'LOCKED') && hasPermission(P['journal.reverse']);
  const isOwnDocument = e.createdBy === me.user.id;

  const run = async (act: JournalAction) => {
    try {
      const result = await action.mutateAsync({ id: e.id, action: act });
      setWarnings(result.sodWarnings ?? []);
      toast.success(`${e.documentNumber} ${ACTION_LABEL[act].verb}.`);
      setPending(null);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{e.documentNumber}</span>
            <JournalStatusBadge status={e.status} />
            <Badge variant="outline">{titleCase(e.journalType)}</Badge>
          </span>
        }
        description={e.description}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/accounting/journal-entries">
                <ArrowLeft /> All entries
              </Link>
            </Button>
            {editable && hasPermission(P['journal.create']) ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/accounting/journal-entries/${e.id}/edit`}>
                    <Pencil /> Edit
                  </Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                  <Trash2 /> Delete
                </Button>
              </>
            ) : null}
            {canReject ? (
              <Button variant="outline" size="sm" onClick={() => setRejecting(true)}>
                <X /> Reject
              </Button>
            ) : null}
            {canReverse ? (
              <Button variant="outline" size="sm" onClick={() => setReversing(true)}>
                <Undo2 /> Reverse
              </Button>
            ) : null}
            {next && nextAllowed ? (
              <Button size="sm" onClick={() => setPending(next)}>
                {next === 'submit' ? <Send /> : next === 'approve' ? <Check /> : <RotateCcw />}
                {ACTION_LABEL[next].label}
              </Button>
            ) : null}
          </>
        }
      />

      {e.status === 'REJECTED' ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Rejected</AlertTitle>
          <AlertDescription>{e.rejectionReason}</AlertDescription>
        </Alert>
      ) : null}
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
      {next === 'approve' && isOwnDocument ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>
            You created this entry. Depending on the segregation-of-duties policy, approving your
            own document may be blocked or flagged.
          </AlertDescription>
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
                  <TableHead>Account</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-36 text-right">Debit</TableHead>
                  <TableHead className="w-36 text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {e.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">{l.lineNumber}</TableCell>
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
                    <TableCell className="text-muted-foreground">{l.description ?? ''}</TableCell>
                    <TableCell>
                      <Amount value={l.debit} currency={e.currency} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.credit} currency={e.currency} zeroAsDash />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Totals ({e.currency})
                  </TableCell>
                  <TableCell>
                    <Amount value={e.totalDebit} currency={e.currency} className="font-semibold" />
                  </TableCell>
                  <TableCell>
                    <Amount value={e.totalCredit} currency={e.currency} className="font-semibold" />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Document</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
              <Field label="Entry date" value={e.entryDate} />
              <Field label="Posting date" value={e.postingDate ?? '-'} />
              <Field label="Period" value={`${e.periodName} (${e.periodStatus.toLowerCase()})`} />
              <Field label="Reference" value={e.reference ?? '-'} />
              <Field label="Branch" value={e.branchCode ?? '-'} />
              <Field label="Source" value={e.sourceType ? `${e.sourceType}` : 'Manual'} />
              {e.reversalOfNumber ? (
                <Field
                  label="Reverses"
                  value={
                    <Link
                      className="font-mono hover:underline"
                      href={`/accounting/journal-entries/${e.reversalOfId}`}
                    >
                      {e.reversalOfNumber}
                    </Link>
                  }
                />
              ) : null}
              {e.reversedByNumber ? (
                <Field
                  label="Reversed by"
                  value={
                    <Link
                      className="font-mono hover:underline"
                      href={`/accounting/journal-entries/${e.reversedById}`}
                    >
                      {e.reversedByNumber}
                    </Link>
                  }
                />
              ) : null}
            </dl>
            <div className="mt-4 space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
              <Timeline label="Created" who={e.createdByEmail} when={e.createdAt} />
              <Timeline label="Submitted" who={null} when={e.submittedAt} />
              <Timeline label="Approved" who={e.approvedByEmail} when={e.approvedAt} />
              <Timeline label="Rejected" who={null} when={e.rejectedAt} />
              <Timeline label="Posted" who={e.postedByEmail} when={e.postedAt} />
            </div>
            <Button variant="link" size="sm" className="mt-2 px-0" asChild>
              <Link href={`/admin/audit-logs?entityId=${e.id}`}>View audit trail</Link>
            </Button>
          </CardContent>
        </Card>
        <AttachmentsPanel entityType="JOURNAL_ENTRY" entityId={e.id} />
      </div>

      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? `${ACTION_LABEL[pending].label}?` : ''}
        description={
          pending === 'post'
            ? `${e.documentNumber} will be written to the general ledger for ${e.periodName}. Posted entries cannot be edited - only reversed.`
            : pending === 'approve'
              ? 'Approving confirms the entry is correct and ready to post.'
              : 'The entry will be routed for approval.'
        }
        confirmLabel={pending ? ACTION_LABEL[pending].label : 'Confirm'}
        loading={action.isPending}
        onConfirm={() => (pending ? run(pending) : undefined)}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${e.documentNumber}?`}
        description="Draft and rejected entries can be deleted; the document number is not reused and the deletion is audited."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(e.id);
            toast.success(`${e.documentNumber} deleted.`);
            router.push('/accounting/journal-entries');
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <RejectDialog
        open={rejecting}
        onOpenChange={setRejecting}
        entry={e}
        loading={reject.isPending}
        onReject={async (reason) => {
          try {
            await reject.mutateAsync({ id: e.id, reason });
            toast.success(`${e.documentNumber} rejected.`);
            setRejecting(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ReverseDialog
        open={reversing}
        onOpenChange={setReversing}
        entry={e}
        loading={reverse.isPending}
        onReverse={async (reversalDate, description) => {
          try {
            const reversal = await reverse.mutateAsync({
              id: e.id,
              reversalDate,
              description: description || undefined,
            });
            toast.success(`Reversal ${reversal.documentNumber} posted.`);
            setReversing(false);
            router.push(`/accounting/journal-entries/${reversal.id}`);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
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

function Timeline({
  label,
  who,
  when,
}: {
  label: string;
  who: string | null;
  when: string | null;
}) {
  if (!when) return null;
  return (
    <div className="flex justify-between gap-2">
      <span>
        {label}
        {who ? <span className="text-foreground"> by {who}</span> : null}
      </span>
      <span className="whitespace-nowrap">{formatDateTime(when)}</span>
    </div>
  );
}

function RejectDialog({
  open,
  onOpenChange,
  entry,
  loading,
  onReject,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entry: JournalEntryDetail;
  loading: boolean;
  onReject: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reject {entry.documentNumber}</DialogTitle>
          <DialogDescription>
            The preparer can edit and resubmit the entry. The reason is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reject-reason">Reason</Label>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim()}
            loading={loading}
            onClick={() => void onReject(reason.trim())}
          >
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({
  open,
  onOpenChange,
  entry,
  loading,
  onReverse,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entry: JournalEntryDetail;
  loading: boolean;
  onReverse: (date: string, description: string) => Promise<void>;
}) {
  const [date, setDate] = React.useState(today());
  const [description, setDescription] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reverse {entry.documentNumber}</DialogTitle>
          <DialogDescription>
            A mirror-image REVERSAL entry is created and posted immediately. The original stays in
            the ledger and is marked reversed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reversal-date">Reversal date</Label>
            <Input
              id="reversal-date"
              type="date"
              value={date}
              min={entry.entryDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reversal-desc">Description (optional)</Label>
            <Input
              id="reversal-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`Reversal of ${entry.documentNumber}`}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={loading} onClick={() => void onReverse(date, description)}>
            Post reversal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
