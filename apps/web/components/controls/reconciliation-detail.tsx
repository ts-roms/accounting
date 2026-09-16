'use client';
import * as React from 'react';
import Link from 'next/link';
import { Check, Plus, RefreshCw, ShieldCheck, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import { formatMoney } from '@accounting/money';
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
import { useUsers } from '@/lib/api/hooks';
import {
  useAddReconciliationException,
  useApproveReconciliation,
  useAssignReconciliation,
  useReconciliation,
  useReconciliationNotes,
  useResolveReconciliationException,
  useRunReconciliation,
} from '@/lib/api/reconciliation-hooks';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { AttachmentsPanel } from '@/components/enterprise/attachments-panel';
import { Field, Stat } from '@/components/fixed-assets/shared';
import { AREA_LABEL, ReconciliationStatusBadge } from './reconciliation-center';

export function ReconciliationDetailPage({ id }: { id: string }) {
  const { hasPermission, me } = useSession();
  const recon = useReconciliation(id);
  const run = useRunReconciliation();
  const assign = useAssignReconciliation();
  const notes = useReconciliationNotes();
  const addException = useAddReconciliationException();
  const resolveException = useResolveReconciliationException();
  const approve = useApproveReconciliation();
  const [assigning, setAssigning] = React.useState(false);
  const [approving, setApproving] = React.useState(false);
  const [exceptionOpen, setExceptionOpen] = React.useState(false);
  const [resolving, setResolving] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  if (recon.isLoading || !recon.data) return <Skeleton className="h-64" />;
  const r = recon.data;
  const final = r.status === 'APPROVED';
  const canPrepare = hasPermission(P['reconciliation.prepare']) && !final;
  const canApprove =
    hasPermission(P['reconciliation.approve']) && !final && r.preparedBy !== me?.user.id;
  const unexplainedOk =
    Number(r.unexplained) === 0 || Math.abs(Number(r.unexplained)) <= Number(r.materiality);

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {AREA_LABEL[r.area]} · {r.asOf} <ReconciliationStatusBadge status={r.status} />
          </span>
        }
        description={`Control ${r.controlAccountCode} ${r.controlAccountName} · computed ${formatDateTime(r.computedAt)} by ${r.preparedByName ?? '-'}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" asChild>
              <Link href="/accounting/reconciliation">Back to center</Link>
            </Button>
            {canPrepare ? (
              <>
                <Button
                  variant="outline"
                  disabled={run.isPending}
                  onClick={async () => {
                    try {
                      await run.mutateAsync({ area: r.area, asOf: r.asOf });
                      toast.success('Recomputed from live data.');
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                  data-testid="recon-recompute"
                >
                  <RefreshCw /> Recompute
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setAssigning(true)}
                  data-testid="recon-assign"
                >
                  <UserCheck /> Assign reviewer
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setExceptionOpen(true)}
                  data-testid="recon-add-exception"
                >
                  <Plus /> Log exception
                </Button>
              </>
            ) : null}
            {canApprove ? (
              <Button onClick={() => setApproving(true)} data-testid="recon-approve">
                <ShieldCheck /> Approve
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Subledger" value={formatMoney(r.expectedBalance)} />
        <Stat label="Ledger" value={formatMoney(r.actualBalance)} />
        <Stat
          label="Variance"
          value={formatMoney(r.variance)}
          danger={Number(r.variance) !== 0 && Math.abs(Number(r.variance)) > Number(r.materiality)}
          hint={`materiality ${formatMoney(r.materiality)}`}
        />
        <Stat
          label="Unexplained"
          value={<span data-testid="recon-unexplained">{formatMoney(r.unexplained)}</span>}
          danger={!unexplainedOk}
          hint={`${r.openExceptions} open exception(s)`}
        />
      </div>
      {!unexplainedOk || r.openExceptions > 0 ? (
        <Card className="border-warning">
          <CardContent className="p-3 text-sm">
            Approval is blocked until every exception is resolved and the unexplained variance is
            within materiality. Correct the books and recompute, or log exceptions that explain the
            difference.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Subledger</TableHead>
                  <TableHead className="text-right">Ledger</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.lines.map((l) => (
                  <TableRow key={l.accountId} data-testid="recon-line">
                    <TableCell>
                      <Link
                        className="font-mono text-xs hover:underline"
                        href={`/accounting/general-ledger?accountId=${l.accountId}&to=${r.asOf}`}
                      >
                        {l.code} {l.name}
                      </Link>
                      {l.note ? (
                        <div className="text-xs text-muted-foreground">{l.note}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Amount value={l.expected} />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.actual} />
                    </TableCell>
                    <TableCell>
                      <Amount
                        value={l.difference}
                        zeroAsDash
                        className={Number(l.difference) ? 'font-semibold text-critical' : ''}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 p-4">
            <h2 className="font-medium">Review</h2>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
              <Field label="Prepared by" value={r.preparedByName ?? '-'} />
              <Field label="Reviewer" value={r.reviewerName ?? '-'} />
              <Field
                label="Approved by"
                value={
                  r.approvedByName ? `${r.approvedByName} · ${formatDateTime(r.approvedAt)}` : '-'
                }
              />
              <Field label="Explained" value={formatMoney(r.explained)} />
            </dl>
            {r.notes ? (
              <pre
                className="whitespace-pre-wrap rounded bg-muted p-2 text-xs"
                data-testid="recon-notes"
              >
                {r.notes}
              </pre>
            ) : null}
            {canPrepare ? (
              <div className="space-y-1">
                <Label htmlFor="recon-note">Add a note</Label>
                <Textarea
                  id="recon-note"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!note.trim() || notes.isPending}
                  onClick={async () => {
                    try {
                      await notes.mutateAsync({ id, notes: note.trim() });
                      setNote('');
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  Add note
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Exception</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Resolution</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.exceptions.map((e) => (
                <TableRow key={e.id} data-testid="recon-exception">
                  <TableCell>
                    <div>{e.description}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.reference ? `${e.reference} · ` : ''}raised by {e.raisedByName ?? '-'}{' '}
                      {formatDateTime(e.createdAt)}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Amount value={e.amount} />
                  </TableCell>
                  <TableCell>
                    <Badge variant={e.status === 'RESOLVED' ? 'success' : 'warning'}>
                      {e.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {e.resolution
                      ? `${e.resolution} — ${e.resolvedByName ?? ''} ${formatDateTime(e.resolvedAt)}`
                      : '-'}
                  </TableCell>
                  <TableCell>
                    {e.status === 'OPEN' && canPrepare ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setResolving(e.id)}
                        data-testid="recon-resolve"
                      >
                        <Check /> Resolve
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {r.exceptions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No exceptions logged.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <AttachmentsPanel entityType="RECONCILIATION" entityId={id} />

      <AssignDialog
        open={assigning}
        onOpenChange={setAssigning}
        onAssign={async (reviewerId, text) => {
          try {
            await assign.mutateAsync({ id, reviewerId, notes: text || undefined });
            toast.success('Reviewer assigned.');
            setAssigning(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
        loading={assign.isPending}
      />
      <ExceptionDialog
        open={exceptionOpen}
        onOpenChange={setExceptionOpen}
        loading={addException.isPending}
        onSubmit={async (input) => {
          try {
            await addException.mutateAsync({ id, ...input });
            toast.success('Exception logged.');
            setExceptionOpen(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ResolveDialog
        open={Boolean(resolving)}
        onOpenChange={(o) => !o && setResolving(null)}
        loading={resolveException.isPending}
        onSubmit={async (resolution) => {
          try {
            await resolveException.mutateAsync({ id, exceptionId: resolving!, resolution });
            toast.success('Exception resolved.');
            setResolving(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        title="Approve this reconciliation?"
        description={`Variance ${formatMoney(r.variance)}, unexplained ${formatMoney(r.unexplained)}, materiality ${formatMoney(r.materiality)}. Approval is final and audited.`}
        confirmLabel="Approve"
        loading={approve.isPending}
        onConfirm={async () => {
          try {
            await approve.mutateAsync({ id });
            toast.success('Reconciliation approved.');
            setApproving(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

function AssignDialog({
  open,
  onOpenChange,
  onAssign,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAssign: (reviewerId: string, notes: string) => Promise<void>;
  loading: boolean;
}) {
  const users = useUsers({ status: 'ACTIVE', pageSize: 100 });
  const [reviewerId, setReviewerId] = React.useState('');
  const [text, setText] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Assign a reviewer</DialogTitle>
          <DialogDescription>
            The reconciliation moves to under review. The reviewer must not be the preparer to
            approve it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Reviewer</Label>
            <Select value={reviewerId} onValueChange={setReviewerId}>
              <SelectTrigger data-testid="recon-reviewer">
                <SelectValue placeholder="Pick a user" />
              </SelectTrigger>
              <SelectContent>
                {users.data?.items.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.firstName} {u.lastName} · {u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="assign-notes">Notes (optional)</Label>
            <Textarea
              id="assign-notes"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={loading}
            disabled={!reviewerId}
            onClick={() => void onAssign(reviewerId, text)}
            data-testid="recon-assign-confirm"
          >
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExceptionDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (input: { description: string; amount: string; reference?: string }) => Promise<void>;
  loading: boolean;
}) {
  const [description, setDescription] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [reference, setReference] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Log an exception</DialogTitle>
          <DialogDescription>
            Name the cause and the signed amount it explains (ledger minus subledger). Resolved
            exceptions reduce the unexplained variance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="exc-desc">Description</Label>
            <Input
              id="exc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="exc-description"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exc-amount">Amount</Label>
            <Input
              id="exc-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="exc-amount"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="exc-ref">Reference (optional)</Label>
            <Input id="exc-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={loading}
            disabled={description.trim().length < 3 || !amount.trim()}
            onClick={() =>
              void onSubmit({
                description: description.trim(),
                amount: amount.trim(),
                reference: reference.trim() || undefined,
              })
            }
            data-testid="exc-save"
          >
            Log exception
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResolveDialog({
  open,
  onOpenChange,
  onSubmit,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (resolution: string) => Promise<void>;
  loading: boolean;
}) {
  const [resolution, setResolution] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Resolve exception</DialogTitle>
          <DialogDescription>
            Record how it was resolved (correcting journal, timing cleared, ...).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="exc-resolution">Resolution</Label>
          <Textarea
            id="exc-resolution"
            rows={3}
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            data-testid="exc-resolution"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={loading}
            disabled={resolution.trim().length < 3}
            onClick={() => void onSubmit(resolution.trim())}
            data-testid="exc-resolve-confirm"
          >
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
