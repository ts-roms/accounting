'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  CLOSE_TYPES,
  P,
  type CloseStatus,
  type CloseTaskStatus,
  type CloseType,
} from '@accounting/types';
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
  StatusBadge,
} from '@accounting/ui';
import { useFiscalYears } from '@/lib/api/accounting-hooks';
import { describeError } from '@/lib/api/client';
import {
  useAddCloseTask,
  useCancelClose,
  useClose,
  useCloseDecision,
  useCloses,
  useRefreshClose,
  useStartClose,
  useUpdateCloseTask,
} from '@/lib/api/close-hooks';
import { useUsers } from '@/lib/api/hooks';
import type { CloseTaskView, CloseView } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Stat } from '@/components/fixed-assets/shared';
import { toneOf } from '@/components/status';

const STATUS_VARIANT: Record<
  CloseStatus,
  'secondary' | 'warning' | 'success' | 'outline' | 'destructive'
> = {
  IN_PROGRESS: 'secondary',
  READY: 'warning',
  APPROVED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'outline',
};
const TASK_VARIANT: Record<
  CloseTaskStatus,
  'secondary' | 'warning' | 'success' | 'outline' | 'destructive'
> = {
  PENDING: 'outline',
  IN_PROGRESS: 'secondary',
  DONE: 'success',
  SKIPPED: 'warning',
  BLOCKED: 'destructive',
};

export function CloseStatusBadge({ status }: { status: CloseStatus }) {
  return (
    <StatusBadge tone={toneOf(STATUS_VARIANT[status])} data-testid="close-status">
      {status.replace('_', ' ')}
    </StatusBadge>
  );
}

export function FinancialClosePage() {
  const router = useRouter();
  const table = useTableState({ pageSize: 25 });
  const closes = useCloses(table.query);
  const [starting, setStarting] = React.useState(false);
  const columns = React.useMemo<ColumnDef<CloseView>[]>(
    () => [
      {
        id: 'period',
        header: 'Period',
        enableSorting: false,
        cell: ({ row }) => <span className="font-medium">{row.original.periodName}</span>,
      },
      {
        id: 'type',
        header: 'Type',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.closeType),
      },
      {
        id: 'progress',
        header: 'Progress',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2 text-xs">
            <span className="h-1.5 w-24 overflow-hidden rounded bg-muted">
              <span
                className="block h-full bg-primary"
                style={{ width: `${row.original.progress}%` }}
              />
            </span>
            {row.original.progress}% ({row.original.doneCount}/{row.original.taskCount})
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <CloseStatusBadge status={row.original.status} />,
      },
      {
        id: 'period-status',
        header: 'Period',
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="outline">{row.original.periodStatus.replace('_', ' ')}</Badge>
        ),
      },
      {
        id: 'who',
        header: 'Started / approved',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.startedByName ?? '-'} · {row.original.approvedByName ?? 'not approved'}
          </span>
        ),
      },
      {
        id: 'evaluated',
        header: 'Evaluated',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.evaluatedAt ? formatDateTime(row.original.evaluatedAt) : '-'}
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Financial close"
        description="Month, quarter and year-end closes: a checklist the system evaluates where it can, blockers driven by company policy, management approval, then the period closes."
        actions={
          <Can permissions={[P['close.manage']]}>
            <Button onClick={() => setStarting(true)} data-testid="close-start">
              <Play /> Start a close
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={closes.data}
        isLoading={closes.isLoading}
        isFetching={closes.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/accounting/financial-close/${r.id}`)}
        emptyState={
          <EmptyState
            title="No closes yet"
            description="Start a close for the period you are closing; the checklist is evaluated immediately."
          />
        }
      />
      <StartCloseDialog open={starting} onOpenChange={setStarting} />
    </>
  );
}

function StartCloseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  const years = useFiscalYears();
  const start = useStartClose();
  const [periodId, setPeriodId] = React.useState('');
  const [closeType, setCloseType] = React.useState<CloseType>('MONTH');
  const openPeriods = (years.data ?? []).flatMap((y) =>
    y.periods
      .filter((p) => p.status === 'OPEN' || p.status === 'SOFT_CLOSED')
      .map((p) => ({ ...p, year: y.name })),
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Start a close</DialogTitle>
          <DialogDescription>
            Pick the period being closed. A year-end close also runs the year-end closing entry when
            completed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Period</Label>
            <Select value={periodId} onValueChange={setPeriodId}>
              <SelectTrigger data-testid="close-period">
                <SelectValue placeholder="Choose a period" />
              </SelectTrigger>
              <SelectContent>
                {openPeriods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.year} · {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Close type</Label>
            <Select value={closeType} onValueChange={(v) => setCloseType(v as CloseType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLOSE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={start.isPending}
            disabled={!periodId}
            onClick={async () => {
              try {
                const close = await start.mutateAsync({ fiscalPeriodId: periodId, closeType });
                onOpenChange(false);
                router.push(`/accounting/financial-close/${close.id}`);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
            data-testid="close-start-confirm"
          >
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FinancialCloseDetailPage({ id }: { id: string }) {
  const { hasPermission } = useSession();
  const close = useClose(id);
  const refresh = useRefreshClose();
  const updateTask = useUpdateCloseTask();
  const addTask = useAddCloseTask();
  const decide = useCloseDecision();
  const cancel = useCancelClose();
  const users = useUsers({ status: 'ACTIVE', pageSize: 100 });
  const [editing, setEditing] = React.useState<CloseTaskView | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'approve' | 'complete' | 'cancel' | null>(null);
  const [reason, setReason] = React.useState('');
  if (close.isLoading || !close.data) return <Skeleton className="h-64" />;
  const c = close.data;
  const live = c.status === 'IN_PROGRESS' || c.status === 'READY' || c.status === 'APPROVED';
  const canManage = hasPermission(P['close.manage']) && live;
  const blocking = c.blockers.filter((b) => b.blocking);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      setConfirm(null);
      setEditing(null);
      setAdding(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {c.periodName} · {titleCase(c.closeType)} close <CloseStatusBadge status={c.status} />
          </span>
        }
        description={`Period ${c.periodStart} - ${c.periodEnd} (${c.periodStatus.replace('_', ' ').toLowerCase()}) · started by ${c.startedByName ?? '-'}${c.evaluatedAt ? ` · evaluated ${formatDateTime(c.evaluatedAt)}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" asChild>
              <Link href="/accounting/financial-close">All closes</Link>
            </Button>
            {canManage ? (
              <>
                <Button
                  variant="outline"
                  disabled={refresh.isPending}
                  onClick={() => run(() => refresh.mutateAsync(id), 'Checklist re-evaluated.')}
                  data-testid="close-refresh"
                >
                  <RefreshCw /> Re-evaluate
                </Button>
                <Button variant="outline" onClick={() => setAdding(true)}>
                  <Plus /> Add task
                </Button>
                <Button variant="ghost" onClick={() => setConfirm('cancel')}>
                  Cancel close
                </Button>
              </>
            ) : null}
            {live && c.status !== 'APPROVED' && hasPermission(P['close.approve']) ? (
              <Button
                onClick={() => setConfirm('approve')}
                disabled={c.status !== 'READY'}
                data-testid="close-approve"
              >
                <ShieldCheck /> Approve
              </Button>
            ) : null}
            {c.status === 'APPROVED' && hasPermission(P['period.close']) ? (
              <Button onClick={() => setConfirm('complete')} data-testid="close-complete">
                <Lock /> Close period
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-3 md:grid-cols-4">
        <Stat
          label="Progress"
          value={<span data-testid="close-progress">{c.progress}%</span>}
          hint={`${c.doneCount} of ${c.taskCount} required tasks`}
        />
        <Stat
          label="Blocking"
          value={blocking.length}
          danger={blocking.length > 0}
          hint="checks the policy requires"
        />
        <Stat
          label="Approval"
          value={c.approvedByName ?? '-'}
          hint={
            c.approvedAt
              ? formatDateTime(c.approvedAt)
              : c.status === 'READY'
                ? 'ready for management approval'
                : 'not yet'
          }
        />
        <Stat
          label="Completed"
          value={c.completedByName ?? '-'}
          hint={c.completedAt ? formatDateTime(c.completedAt) : '-'}
        />
      </div>
      {c.blockers.length ? (
        <Card className={blocking.length ? 'border-critical' : 'border-warning'}>
          <CardContent className="space-y-1 p-3 text-sm">
            {c.blockers.map((b) => (
              <div key={b.key} className="flex items-start gap-2" data-testid="close-blocker">
                {b.blocking ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-critical" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" />
                )}
                <span>
                  {b.message}
                  <span className="ml-1 text-xs text-muted-foreground">
                    {b.blocking ? '(blocks approval)' : '(informational)'}
                  </span>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner / reviewer</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.tasks.map((t) => (
                <TableRow key={t.id} data-testid="close-task" data-key={t.key}>
                  <TableCell className="text-xs text-muted-foreground">{t.sequence}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {t.status === 'DONE' ? (
                        <CheckCircle2 className="h-4 w-4 text-success" />
                      ) : null}
                      <span className="font-medium">{t.title}</span>
                      <Badge variant="outline">{t.kind === 'AUTO' ? 'auto' : 'manual'}</Badge>
                      {!t.required ? (
                        <span className="text-xs text-muted-foreground">optional</span>
                      ) : null}
                    </div>
                    {t.notes ? (
                      <div className="text-xs text-muted-foreground">{t.notes}</div>
                    ) : null}
                    {t.skipReason ? (
                      <div className="text-xs text-warning">skipped: {t.skipReason}</div>
                    ) : null}
                    {t.kind === 'AUTO' && Object.keys(t.detail).length ? (
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {summariseDetail(t.detail)}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={toneOf(TASK_VARIANT[t.status])}>
                      {t.status.replace('_', ' ')}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.ownerName ?? '-'} / {t.reviewerName ?? '-'}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t.completedAt
                      ? `${t.completedByName ?? ''} ${formatDateTime(t.completedAt)}`
                      : '-'}
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(t)}
                        data-testid="close-task-edit"
                      >
                        {t.kind === 'AUTO' ? 'Assign' : 'Update'}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <TaskDialog
        task={editing}
        users={users.data?.items ?? []}
        onOpenChange={(o) => !o && setEditing(null)}
        loading={updateTask.isPending}
        onSubmit={(input) =>
          run(() => updateTask.mutateAsync({ id, taskId: editing!.id, ...input }), 'Task updated.')
        }
      />
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Add a manual task</DialogTitle>
            <DialogDescription>
              Company-specific steps that belong on this checklist.
            </DialogDescription>
          </DialogHeader>
          <AddTaskForm
            loading={addTask.isPending}
            onSubmit={(title, required) =>
              run(() => addTask.mutateAsync({ id, title, required }), 'Task added.')
            }
          />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm === 'approve'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Give management approval?"
        description="Every required task is done and no policy blocker remains. Approval is withdrawn automatically if a check regresses before the period is closed."
        confirmLabel="Approve"
        loading={decide.isPending}
        onConfirm={() =>
          run(() => decide.mutateAsync({ id, action: 'approve' }), 'Close approved.')
        }
      />
      <ConfirmDialog
        open={confirm === 'complete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Close the period?"
        description="The period is closed (its posted entries lock), the year is closed for a year-end close, and the period is locked permanently if the policy says so."
        confirmLabel="Close period"
        destructive
        loading={decide.isPending}
        onConfirm={() =>
          run(() => decide.mutateAsync({ id, action: 'complete' }), 'Period closed.')
        }
      />
      <Dialog open={confirm === 'cancel'} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Cancel this close?</DialogTitle>
            <DialogDescription>
              The checklist is kept for the record; a new close can be started later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="cancel-reason">Reason</Label>
            <Input id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Keep
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3}
              loading={cancel.isPending}
              onClick={() =>
                run(() => cancel.mutateAsync({ id, reason: reason.trim() }), 'Close cancelled.')
              }
            >
              Cancel close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function summariseDetail(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(
      ([k, v]) =>
        `${k}: ${Array.isArray(v) ? v.map((x) => (typeof x === 'object' && x ? Object.values(x as object).join(' ') : String(x))).join(', ') : String(v)}`,
    )
    .join(' · ');
}

function TaskDialog({
  task,
  users,
  onOpenChange,
  loading,
  onSubmit,
}: {
  task: CloseTaskView | null;
  users: Array<{ id: string; firstName: string; lastName: string }>;
  onOpenChange: (o: boolean) => void;
  loading: boolean;
  onSubmit: (input: {
    status?: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED';
    ownerId?: string | null;
    reviewerId?: string | null;
    notes?: string;
    reason?: string;
  }) => void;
}) {
  const [status, setStatus] = React.useState<string>('');
  const [ownerId, setOwnerId] = React.useState<string>('');
  const [reviewerId, setReviewerId] = React.useState<string>('');
  const [notes, setNotes] = React.useState('');
  const [reason, setReason] = React.useState('');
  React.useEffect(() => {
    if (task) {
      setStatus(task.kind === 'MANUAL' ? task.status : '');
      setOwnerId(task.ownerId ?? '');
      setReviewerId(task.reviewerId ?? '');
      setNotes(task.notes ?? '');
      setReason(task.skipReason ?? '');
    }
  }, [task]);
  const NONE = '__none__';
  return (
    <Dialog open={Boolean(task)} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        {task ? (
          <>
            <DialogHeader>
              <DialogTitle>{task.title}</DialogTitle>
              <DialogDescription>
                {task.kind === 'AUTO'
                  ? 'Evaluated by the system - assign who follows it up and leave notes.'
                  : 'Record who owns the step and where it stands.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {task.kind === 'MANUAL' ? (
                <div className="space-y-1">
                  <Label>Status</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger data-testid="task-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED'] as const).map((s) => (
                        <SelectItem key={s} value={s}>
                          {s.replace('_', ' ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {status === 'SKIPPED' ? (
                <div className="space-y-1">
                  <Label htmlFor="task-reason">Reason for skipping</Label>
                  <Input
                    id="task-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="task-reason"
                  />
                </div>
              ) : null}
              <div className="space-y-1">
                <Label>Owner</Label>
                <Select
                  value={ownerId || NONE}
                  onValueChange={(v) => setOwnerId(v === NONE ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.firstName} {u.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Reviewer</Label>
                <Select
                  value={reviewerId || NONE}
                  onValueChange={(v) => setReviewerId(v === NONE ? '' : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.firstName} {u.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="task-notes">Notes</Label>
                <Textarea
                  id="task-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  data-testid="task-notes"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                loading={loading}
                disabled={status === 'SKIPPED' && task.required && reason.trim().length < 3}
                onClick={() =>
                  onSubmit({
                    status:
                      task.kind === 'MANUAL'
                        ? (status as 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED')
                        : undefined,
                    ownerId: ownerId || null,
                    reviewerId: reviewerId || null,
                    notes: notes.trim() || undefined,
                    reason: reason.trim() || undefined,
                  })
                }
                data-testid="task-save"
              >
                Save
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AddTaskForm({
  loading,
  onSubmit,
}: {
  loading: boolean;
  onSubmit: (title: string, required: boolean) => void;
}) {
  const [title, setTitle] = React.useState('');
  const [required, setRequired] = React.useState('true');
  return (
    <>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="new-task-title">Title</Label>
          <Input id="new-task-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Required</Label>
          <Select value={required} onValueChange={setRequired}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">Required before approval</SelectItem>
              <SelectItem value="false">Optional</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <Button
          loading={loading}
          disabled={title.trim().length < 2}
          onClick={() => onSubmit(title.trim(), required === 'true')}
        >
          Add
        </Button>
      </DialogFooter>
    </>
  );
}
