'use client';
import * as React from 'react';
import { CalendarPlus, Lock, LockKeyhole, LockOpen, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
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
  useCloseFiscalYear,
  useCreateFiscalYear,
  useFiscalYears,
  usePeriodAction,
} from '@/lib/api/accounting-hooks';
import type { FiscalPeriod, FiscalYear } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';

type PeriodAction = 'soft-close' | 'close' | 'lock' | 'reopen';
const CLOSED_STATES = new Set<FiscalPeriod['status']>(['CLOSED', 'LOCKED']);
const STATUS_VARIANT: Record<
  FiscalPeriod['status'],
  'success' | 'warning' | 'secondary' | 'destructive'
> = {
  OPEN: 'success',
  SOFT_CLOSED: 'warning',
  CLOSED: 'secondary',
  LOCKED: 'destructive',
};
const ACTION_LABEL: Record<
  PeriodAction,
  { title: string; help: string; button: string; done: string }
> = {
  'soft-close': {
    title: 'Soft close',
    help: 'Provisionally closes the books: only users allowed to post into soft-closed periods can still post late adjustments. Reversible with a reason.',
    button: 'Soft close',
    done: 'soft-closed',
  },
  close: {
    title: 'Close',
    help: 'Posted entries in this period become locked and no further postings are accepted. Reopening later requires elevated permission and a reason. The action is audited.',
    button: 'Close period',
    done: 'closed',
  },
  lock: {
    title: 'Lock',
    help: 'Final: a locked period can never be reopened and accepts no postings from anyone - the database enforces it. Use once statements have been issued.',
    button: 'Lock permanently',
    done: 'locked',
  },
  reopen: {
    title: 'Reopen',
    help: 'Reopening allows postings again. It requires elevated permission and is audited with the reason below (at least 5 characters).',
    button: 'Reopen period',
    done: 'reopened',
  },
};

export default function PeriodClosingPage() {
  const { hasPermission } = useSession();
  const years = useFiscalYears();
  const periodAction = usePeriodAction();
  const closeYear = useCloseFiscalYear();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [pending, setPending] = React.useState<{
    period: FiscalPeriod;
    action: PeriodAction;
  } | null>(null);
  const [reason, setReason] = React.useState('');
  const [yearToClose, setYearToClose] = React.useState<FiscalYear | null>(null);

  const runPeriod = async () => {
    if (!pending) return;
    try {
      await periodAction.mutateAsync({
        id: pending.period.id,
        action: pending.action,
        reason: reason || undefined,
      });
      toast.success(`${pending.period.name} ${ACTION_LABEL[pending.action].done}.`);
      setPending(null);
      setReason('');
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Period Closing"
        description="Periods close in sequence once every journal in them is posted or rejected. Year-end close transfers the net result to retained earnings."
        actions={
          <Can permissions={[P['period.manage']]}>
            <Button onClick={() => setCreateOpen(true)}>
              <CalendarPlus /> New fiscal year
            </Button>
          </Can>
        }
      />
      {years.data?.length === 0 ? (
        <EmptyState
          title="No fiscal year"
          description="Create a fiscal year to start posting journal entries."
        />
      ) : null}
      {years.data?.map((year) => {
        const allClosed = year.periods.every((p) => p.status === 'CLOSED');
        return (
          <Card key={year.id}>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2">
                  {year.name}
                  <Badge variant={year.status === 'CLOSED' ? 'secondary' : 'success'}>
                    {year.status}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {year.startDate} to {year.endDate}
                  {year.closedAt ? ` - closed ${formatDateTime(year.closedAt)}` : ''}
                </CardDescription>
              </div>
              {year.status === 'OPEN' && hasPermission(P['period.close']) ? (
                <Button
                  size="sm"
                  variant={allClosed ? 'default' : 'outline'}
                  disabled={!allClosed}
                  onClick={() => setYearToClose(year)}
                >
                  <Lock /> Close year
                </Button>
              ) : null}
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Dates</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Closed</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {year.periods.map((p, index) => {
                    const previousClosed =
                      index === 0 || CLOSED_STATES.has(year.periods[index - 1]!.status);
                    const laterClosed = year.periods
                      .slice(index + 1)
                      .some((q) => q.status === 'CLOSED' || q.status === 'LOCKED');
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {p.periodNumber}
                        </TableCell>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {p.startDate} - {p.endDate}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[p.status]} data-testid="period-status">
                            {p.status.replace('_', ' ')}
                          </Badge>
                          {p.reopenReason ? (
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              reopened: {p.reopenReason}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {p.closedAt ? formatDateTime(p.closedAt) : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {year.status === 'OPEN' &&
                          p.status === 'OPEN' &&
                          hasPermission(P['period.close']) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setPending({ period: p, action: 'soft-close' })}
                              data-testid="period-soft-close"
                            >
                              <ShieldAlert /> Soft close
                            </Button>
                          ) : null}
                          {year.status === 'OPEN' &&
                          (p.status === 'OPEN' || p.status === 'SOFT_CLOSED') &&
                          hasPermission(P['period.close']) ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!previousClosed}
                              onClick={() => setPending({ period: p, action: 'close' })}
                              data-testid="period-close"
                            >
                              <Lock /> Close
                            </Button>
                          ) : null}
                          {p.status === 'CLOSED' && hasPermission(P['period.lock']) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setPending({ period: p, action: 'lock' })}
                              data-testid="period-lock"
                            >
                              <LockKeyhole /> Lock
                            </Button>
                          ) : null}
                          {year.status === 'OPEN' &&
                          (p.status === 'CLOSED' || p.status === 'SOFT_CLOSED') &&
                          hasPermission(P['period.reopen']) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={laterClosed}
                              onClick={() => setPending({ period: p, action: 'reopen' })}
                              data-testid="period-reopen"
                            >
                              <LockOpen /> Reopen
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {pending ? ACTION_LABEL[pending.action].title : ''} {pending?.period.name}?
            </DialogTitle>
            <DialogDescription>
              {pending ? ACTION_LABEL[pending.action].help : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="period-reason">
              Reason {pending?.action === 'reopen' ? '' : '(optional)'}
            </Label>
            <Textarea
              id="period-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              loading={periodAction.isPending}
              disabled={pending?.action === 'reopen' && reason.trim().length < 5}
              onClick={() => void runPeriod()}
              data-testid="period-confirm"
            >
              {pending ? ACTION_LABEL[pending.action].button : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(yearToClose)}
        onOpenChange={(open) => !open && setYearToClose(null)}
        title={`Close ${yearToClose?.name}?`}
        description="A CLOSING journal dated on the last day of the year transfers revenue and expenses to retained earnings. Afterwards no period of this year can be reopened."
        confirmLabel="Close fiscal year"
        destructive
        loading={closeYear.isPending}
        onConfirm={async () => {
          if (!yearToClose) return;
          try {
            await closeYear.mutateAsync(yearToClose.id);
            toast.success(`${yearToClose.name} closed.`);
            setYearToClose(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <CreateYearDialog open={createOpen} onOpenChange={setCreateOpen} years={years.data ?? []} />
    </>
  );
}

function CreateYearDialog({
  open,
  onOpenChange,
  years,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  years: FiscalYear[];
}) {
  const create = useCreateFiscalYear();
  const latest = years[0];
  const suggested = latest ? nextDay(latest.endDate) : `${new Date().getUTCFullYear()}-01-01`;
  const [startDate, setStartDate] = React.useState(suggested);
  React.useEffect(() => {
    if (open) setStartDate(suggested);
  }, [open, suggested]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New fiscal year</DialogTitle>
          <DialogDescription>
            Twelve monthly periods are generated from the start date.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="fy-start">Start date</Label>
          <Input
            id="fy-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            onClick={async () => {
              try {
                const fy = await create.mutateAsync({ startDate });
                toast.success(`${fy.name} created with ${fy.periods.length} periods.`);
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
