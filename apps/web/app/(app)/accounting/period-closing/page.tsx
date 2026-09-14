'use client';
import * as React from 'react';
import { CalendarPlus, Lock, LockOpen } from 'lucide-react';
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

export default function PeriodClosingPage() {
  const { hasPermission } = useSession();
  const years = useFiscalYears();
  const periodAction = usePeriodAction();
  const closeYear = useCloseFiscalYear();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [pending, setPending] = React.useState<{
    period: FiscalPeriod;
    action: 'close' | 'reopen';
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
      toast.success(
        `${pending.period.name} ${pending.action === 'close' ? 'closed' : 'reopened'}.`,
      );
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
                      index === 0 || year.periods[index - 1]!.status === 'CLOSED';
                    const laterClosed = year.periods
                      .slice(index + 1)
                      .some((q) => q.status === 'CLOSED');
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
                          <Badge variant={p.status === 'CLOSED' ? 'secondary' : 'success'}>
                            {p.status}
                          </Badge>
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
                              variant="outline"
                              disabled={!previousClosed}
                              onClick={() => setPending({ period: p, action: 'close' })}
                            >
                              <Lock /> Close
                            </Button>
                          ) : null}
                          {year.status === 'OPEN' &&
                          p.status === 'CLOSED' &&
                          hasPermission(P['period.reopen']) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={laterClosed}
                              onClick={() => setPending({ period: p, action: 'reopen' })}
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
              {pending?.action === 'close' ? 'Close' : 'Reopen'} {pending?.period.name}?
            </DialogTitle>
            <DialogDescription>
              {pending?.action === 'close'
                ? 'Posted entries in this period become locked and no further postings are accepted. The action is audited.'
                : 'Reopening allows postings again. This requires elevated permission and is audited with the reason below.'}
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
              disabled={pending?.action === 'reopen' && !reason.trim()}
              onClick={() => void runPeriod()}
            >
              {pending?.action === 'close' ? 'Close period' : 'Reopen period'}
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
