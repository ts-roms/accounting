'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
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
  Skeleton,
  Switch,
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
  useCreateLeaseRun,
  useLeaseRun,
  useLeaseRunPreview,
  useLeaseRuns,
  useLeaseSettings,
  useReverseLeaseRun,
  useUpdateLeaseSettings,
} from '@/lib/api/lease-hooks';
import type { LeaseRun } from '@/lib/api/lease-types';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { Amount } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { LEASES_PATH, LeaseRunStatusBadge } from './shared';

const endOfLastMonth = () => {
  const d = new Date();
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

export function LeaseRunsPage() {
  const { hasPermission } = useSession();
  const table = useTableState({ sortBy: 'periodEnd', sortDir: 'desc' });
  const runs = useLeaseRuns(table.query);
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const columns = React.useMemo<ColumnDef<LeaseRun>[]>(
    () => [
      {
        accessorKey: 'documentNumber',
        header: 'Run',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.documentNumber}</span>,
      },
      {
        accessorKey: 'periodEnd',
        header: 'Period end',
        cell: ({ row }) => (
          <span>
            {row.original.periodEnd}
            {row.original.description ? (
              <span className="ml-2 text-xs text-muted-foreground">{row.original.description}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'leases',
        header: () => <div className="text-right">Leases / months</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-right tabular">
            {row.original.leaseCount} / {row.original.lineCount}
          </div>
        ),
      },
      {
        id: 'interest',
        header: () => <div className="text-right">Interest</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.interestTotal} />,
      },
      {
        id: 'depreciation',
        header: () => <div className="text-right">Depreciation</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.depreciationTotal} />,
      },
      {
        id: 'journal',
        header: 'Journal',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.journalEntryId ? (
            <Link
              href={`/accounting/journal-entries/${row.original.journalEntryId}`}
              className="font-mono text-xs hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.journalNumber}
            </Link>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <LeaseRunStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Lease Runs"
        description="One ADJUSTING journal per run dated the period end: Dr lease interest expense / Cr lease liability and Dr depreciation expense / Cr right-of-use accumulated depreciation, one pair per lease. Runs are reversed latest first."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={LEASES_PATH}>Leases</Link>
            </Button>
            <Can permissions={[P['lease.post']]}>
              <Button size="sm" onClick={() => setCreating(true)} data-testid="lease-run-new">
                <Plus /> New run
              </Button>
            </Can>
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <DataTable
          columns={columns}
          data={runs.data}
          isLoading={runs.isLoading}
          isFetching={runs.isFetching}
          error={runs.error}
          onRetry={() => void runs.refetch()}
          pagination={table.pagination}
          sorting={table.sorting}
          getRowId={(r) => r.id}
          onRowClick={(r) => setSelected(r.id)}
        />
        {hasPermission(P['lease.view']) ? <SettingsCard /> : null}
      </div>
      <NewRunDialog open={creating} onOpenChange={setCreating} onCreated={setSelected} />
      <RunDetailDialog id={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

function SettingsCard() {
  const { hasPermission } = useSession();
  const settings = useLeaseSettings();
  const update = useUpdateLeaseSettings();
  const canManage = hasPermission(P['lease.manage']);
  const [form, setForm] = React.useState({ shortTerm: '12', lowValue: '0', rate: '8' });
  React.useEffect(() => {
    if (settings.data)
      setForm({
        shortTerm: String(settings.data.shortTermThresholdMonths),
        lowValue: settings.data.lowValueThreshold,
        rate: settings.data.defaultDiscountRate,
      });
  }, [settings.data]);
  const save = async (patch: Parameters<typeof update.mutateAsync>[0]) => {
    try {
      await update.mutateAsync(patch);
      toast.success('Lease settings saved.');
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Policy</CardTitle>
        <CardDescription>
          Thresholds decide which leases stay off the balance sheet; the default rate applies when a
          contract carries none.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {settings.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label>Post runs automatically</Label>
                <p className="text-xs text-muted-foreground">
                  Off: the scheduled job only reminds when months are waiting.
                </p>
              </div>
              <Switch
                checked={settings.data?.autoPostRuns ?? false}
                disabled={!canManage || update.isPending}
                onCheckedChange={(checked) => void save({ autoPostRuns: checked })}
                data-testid="lease-auto-post"
              />
            </div>
            <div className="space-y-1">
              <Label>Short-term threshold (months)</Label>
              <Input
                inputMode="numeric"
                value={form.shortTerm}
                disabled={!canManage}
                onChange={(e) => setForm((f) => ({ ...f, shortTerm: e.target.value }))}
                onBlur={() =>
                  Number(form.shortTerm) !== settings.data?.shortTermThresholdMonths &&
                  void save({ shortTermThresholdMonths: Number(form.shortTerm) })
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Low-value threshold</Label>
              <Input
                inputMode="decimal"
                className="text-right tabular"
                value={form.lowValue}
                disabled={!canManage}
                onChange={(e) => setForm((f) => ({ ...f, lowValue: e.target.value }))}
                onBlur={() =>
                  Number(form.lowValue) !== Number(settings.data?.lowValueThreshold) &&
                  void save({ lowValueThreshold: form.lowValue })
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Default annual rate %</Label>
              <Input
                inputMode="decimal"
                value={form.rate}
                disabled={!canManage}
                onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                onBlur={() =>
                  Number(form.rate) !== Number(settings.data?.defaultDiscountRate) &&
                  void save({ defaultDiscountRate: form.rate })
                }
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function NewRunDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateLeaseRun();
  const [periodEnd, setPeriodEnd] = React.useState(endOfLastMonth());
  const [description, setDescription] = React.useState('');
  const preview = useLeaseRunPreview(open ? periodEnd : null);
  React.useEffect(() => {
    if (open) {
      setPeriodEnd(endOfLastMonth());
      setDescription('');
    }
  }, [open]);
  const submit = async () => {
    try {
      const result = await create.mutateAsync({
        periodEnd,
        description: description.trim() || undefined,
      });
      if ('run' in result && result.run === null) {
        toast.info(result.message);
        onOpenChange(false);
        return;
      }
      const run = result as { id: string; documentNumber: string };
      toast.success(`${run.documentNumber} posted.`);
      onOpenChange(false);
      onCreated(run.id);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New lease run</DialogTitle>
          <DialogDescription>
            Every pending month of an active lease ending on or before the period end is posted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Period end</Label>
            <Input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              data-testid="lease-run-period-end"
            />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {preview.data ? (
            <div className="rounded-md border" data-testid="lease-run-preview">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Lease</TableHead>
                    <TableHead className="text-right">Months</TableHead>
                    <TableHead className="text-right">Interest</TableHead>
                    <TableHead className="text-right">Depreciation</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.data.byLease.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                        Nothing due up to {periodEnd}.
                      </TableCell>
                    </TableRow>
                  ) : (
                    preview.data.byLease.map((l) => (
                      <TableRow key={l.leaseId}>
                        <TableCell>
                          <span className="font-mono text-xs">{l.leaseNumber}</span> {l.leaseName}
                        </TableCell>
                        <TableCell className="text-right tabular">{l.months}</TableCell>
                        <TableCell>
                          <Amount value={l.interest} />
                        </TableCell>
                        <TableCell>
                          <Amount value={l.depreciation} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
                {preview.data.byLease.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right tabular">{preview.data.lines}</TableCell>
                      <TableCell>
                        <Amount value={preview.data.interest} />
                      </TableCell>
                      <TableCell>
                        <Amount value={preview.data.depreciation} />
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                ) : null}
              </Table>
            </div>
          ) : (
            <Skeleton className="h-16" />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={create.isPending || !preview.data || preview.data.lines === 0}
            data-testid="lease-run-post"
          >
            Post run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunDetailDialog({
  id,
  onOpenChange,
}: {
  id: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { hasPermission } = useSession();
  const run = useLeaseRun(id);
  const reverse = useReverseLeaseRun();
  const [reason, setReason] = React.useState('');
  React.useEffect(() => setReason(''), [id]);
  const r = run.data;
  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        {!r ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="font-mono">{r.documentNumber}</span>
                <LeaseRunStatusBadge status={r.status} />
              </DialogTitle>
              <DialogDescription>
                Period end {r.periodEnd}
                {r.description ? ` · ${r.description}` : ''}
                {r.createdByName ? ` · by ${r.createdByName}` : ' · scheduled'} ·{' '}
                {formatDateTime(r.createdAt)}
                {r.journalEntryId ? (
                  <>
                    {' '}
                    · journal{' '}
                    <Link
                      href={`/accounting/journal-entries/${r.journalEntryId}`}
                      className="font-mono hover:underline"
                    >
                      {r.journalNumber}
                    </Link>
                  </>
                ) : null}
                {r.reversalJournalNumber ? (
                  <>
                    {' '}
                    · reversed by <span className="font-mono">{r.reversalJournalNumber}</span> (
                    {r.reversalReason})
                  </>
                ) : null}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-80 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Lease</TableHead>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Interest</TableHead>
                    <TableHead className="text-right">Depreciation</TableHead>
                    <TableHead className="text-right">Closing liability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.lines.map((l) => (
                    <TableRow key={l.lineId}>
                      <TableCell>
                        <Link href={`${LEASES_PATH}/${l.leaseId}`} className="hover:underline">
                          <span className="font-mono text-xs">{l.leaseNumber}</span> {l.leaseName}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {l.sequence} · {l.periodStart} → {l.periodEnd}
                      </TableCell>
                      <TableCell>
                        <Amount value={l.interest} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={l.depreciation} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={l.closingLiability} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>Total</TableCell>
                    <TableCell>
                      <Amount value={r.interestTotal} />
                    </TableCell>
                    <TableCell>
                      <Amount value={r.depreciationTotal} />
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            {r.status === 'POSTED' && hasPermission(P['lease.post']) ? (
              <div className="space-y-2 rounded-md border p-3">
                <Label>Reverse this run</Label>
                <Textarea
                  rows={2}
                  placeholder="Reason (required)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex justify-end">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={reverse.isPending || reason.trim().length < 3}
                    onClick={async () => {
                      try {
                        await reverse.mutateAsync({ id: r.id, reason: reason.trim() });
                        toast.success(`${r.documentNumber} reversed.`);
                      } catch (err) {
                        toast.error(describeError(err));
                      }
                    }}
                  >
                    Reverse
                  </Button>
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
