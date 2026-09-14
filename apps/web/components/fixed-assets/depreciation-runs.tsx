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
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { useFiscalYears } from '@/lib/api/accounting-hooks';
import { describeError } from '@/lib/api/client';
import {
  useCreateDepreciationRun,
  useDeleteDepreciationRun,
  useDepreciationPreview,
  useDepreciationRun,
  useDepreciationRuns,
  useFixedAssetSettings,
  usePostDepreciationRun,
  useReverseDepreciationRun,
  useUpdateFixedAssetSettings,
} from '@/lib/api/assets-banking-hooks';
import type { DepreciationRun, DepreciationRunLine } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { ASSETS_PATH, RunStatusBadge } from './shared';

export function DepreciationRunsPage() {
  const { hasPermission } = useSession();
  const table = useTableState({ sortBy: 'runNumber', sortDir: 'desc' });
  const runs = useDepreciationRuns(table.query);
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const columns = React.useMemo<ColumnDef<DepreciationRun>[]>(
    () => [
      {
        accessorKey: 'runNumber',
        header: 'Run',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.runNumber}</span>,
      },
      {
        id: 'period',
        header: 'Period',
        enableSorting: false,
        cell: ({ row }) => (
          <span>
            {row.original.periodName}
            <span className="ml-2 text-xs text-muted-foreground">
              {row.original.periodStart} → {row.original.periodEnd}
            </span>
          </span>
        ),
      },
      {
        id: 'assets',
        header: () => <div className="text-right">Assets</div>,
        enableSorting: false,
        cell: ({ row }) => <div className="text-right tabular">{row.original.assetCount}</div>,
      },
      {
        id: 'total',
        header: () => <div className="text-right">Depreciation</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.totalAmount} />,
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
        cell: ({ row }) => <RunStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Depreciation"
        description="One run per fiscal period, posted in order: Dr depreciation expense / Cr accumulated depreciation, aggregated per account pair. Only the latest posted run can be reversed."
        actions={
          <Can permissions={[P['depreciation.run']]}>
            <Button onClick={() => setCreating(true)} data-testid="new-run">
              <Plus /> New run
            </Button>
          </Can>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <DataTable
          columns={columns}
          data={runs.data}
          isLoading={runs.isLoading}
          isFetching={runs.isFetching}
          pagination={table.pagination}
          sorting={table.sorting}
          getRowId={(r) => r.id}
          onRowClick={(r) => setSelected(r.id)}
        />
        {hasPermission(P['fixed-asset.view']) ? <SettingsCard /> : null}
      </div>
      <NewRunDialog open={creating} onOpenChange={setCreating} onCreated={setSelected} />
      <RunDetailDialog id={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

function SettingsCard() {
  const { hasPermission } = useSession();
  const settings = useFixedAssetSettings();
  const update = useUpdateFixedAssetSettings();
  const canManage = hasPermission(P['fixed-asset.manage']);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduler</CardTitle>
        <CardDescription>
          On the 1st of each month a job drafts the previous period&apos;s run for every company.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isLoading ? (
          <Skeleton className="h-8" />
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>Post automatically</Label>
              <p className="text-xs text-muted-foreground">
                Off: the run is left as a draft for review.
              </p>
            </div>
            <Switch
              checked={settings.data?.autoPostDepreciation ?? false}
              disabled={!canManage || update.isPending}
              onCheckedChange={async (checked) => {
                try {
                  await update.mutateAsync({ autoPostDepreciation: checked });
                  toast.success('Settings saved.');
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LinesTable({ lines, currency }: { lines: DepreciationRunLine[]; currency?: string }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Asset</TableHead>
          <TableHead className="text-right">Depreciation</TableHead>
          <TableHead className="text-right">Accumulated after</TableHead>
          <TableHead className="text-right">Book value after</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
              No active asset depreciates in this period.
            </TableCell>
          </TableRow>
        ) : (
          lines.map((l) => (
            <TableRow key={l.assetId} data-testid="run-line">
              <TableCell>
                <Link href={`${ASSETS_PATH}/${l.assetId}`} className="hover:underline">
                  <span className="mr-2 font-mono text-xs">{l.assetNumber}</span>
                  {l.name}
                </Link>
                {l.fullyDepreciated ? (
                  <span className="ml-2 text-xs text-muted-foreground">fully depreciated</span>
                ) : null}
              </TableCell>
              <TableCell>
                <Amount value={l.amount} currency={currency} />
              </TableCell>
              <TableCell>
                <Amount value={l.accumulatedAfter} currency={currency} />
              </TableCell>
              <TableCell>
                <Amount value={l.bookValueAfter} currency={currency} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
      {lines.length > 0 ? (
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell>
              <Amount
                value={lines.reduce((s, l) => s + Number(l.amount), 0).toFixed(4)}
                className="font-semibold"
              />
            </TableCell>
            <TableCell colSpan={2} />
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
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
  const years = useFiscalYears(open);
  // Latest posted run (list is ordered by period desc): the next run defaults to the period after it.
  const latest = useDepreciationRuns({ status: 'POSTED', page: 1, pageSize: 1 });
  const [periodId, setPeriodId] = React.useState<string | null>(null);
  const preview = useDepreciationPreview(open ? periodId : null);
  const create = useCreateDepreciationRun();
  const openPeriods = React.useMemo(
    () =>
      (years.data ?? [])
        .flatMap((y) => y.periods.map((p) => ({ ...p, yearName: y.name })))
        .filter((p) => p.status === 'OPEN'),
    [years.data],
  );
  React.useEffect(() => {
    if (!open || periodId || openPeriods.length === 0 || latest.isLoading) return;
    const after = latest.data?.items[0]?.periodEnd;
    const next = after ? openPeriods.find((p) => p.startDate > after) : openPeriods[0];
    setPeriodId((next ?? openPeriods[0])!.id);
  }, [open, periodId, openPeriods, latest.data, latest.isLoading]);
  React.useEffect(() => {
    if (!open) setPeriodId(null);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New depreciation run</DialogTitle>
          <DialogDescription>
            Preview the charge per active asset, then create the draft. Posting happens from the
            run.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Fiscal period</Label>
            <Select value={periodId ?? ''} onValueChange={setPeriodId}>
              <SelectTrigger data-testid="run-period">
                <SelectValue placeholder="Select period" />
              </SelectTrigger>
              <SelectContent>
                {openPeriods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.yearName} · {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Card>
            <CardContent className="p-0">
              {preview.isLoading ? (
                <Skeleton className="m-4 h-24" />
              ) : (
                <LinesTable lines={preview.data ?? []} />
              )}
            </CardContent>
          </Card>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!periodId || create.isPending || (preview.data?.length ?? 0) === 0}
            data-testid="create-run"
            onClick={async () => {
              try {
                const run = await create.mutateAsync({ fiscalPeriodId: periodId! });
                toast.success(`${run.runNumber} drafted.`);
                onOpenChange(false);
                onCreated(run.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create draft
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
  const run = useDepreciationRun(id);
  const post = usePostDepreciationRun();
  const remove = useDeleteDepreciationRun();
  const reverse = useReverseDepreciationRun();
  const [reversing, setReversing] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const canRun = hasPermission(P['depreciation.run']);
  const r = run.data;
  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent>
        {!r ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="font-mono">{r.runNumber}</span>
                <RunStatusBadge status={r.status} />
              </DialogTitle>
              <DialogDescription>
                {r.periodName} ({r.periodStart} → {r.periodEnd}) · {r.assetCount} assets ·{' '}
                {r.journalNumber ? (
                  <Link
                    href={`/accounting/journal-entries/${r.journalEntryId}`}
                    className="font-mono hover:underline"
                  >
                    {r.journalNumber}
                  </Link>
                ) : (
                  'not posted'
                )}
                {r.postedAt ? ` · posted ${formatDateTime(r.postedAt)}` : ''}
              </DialogDescription>
            </DialogHeader>
            <Card>
              <CardContent className="p-0">
                <LinesTable lines={r.lines} currency={r.currency} />
              </CardContent>
            </Card>
            {reversing ? (
              <div className="space-y-1">
                <Label>Reason for reversal</Label>
                <Textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                />
              </div>
            ) : null}
            <DialogFooter>
              {canRun && r.status === 'DRAFT' ? (
                <>
                  <Button
                    variant="outline"
                    disabled={remove.isPending}
                    onClick={async () => {
                      try {
                        await remove.mutateAsync(r.id);
                        toast.success('Draft discarded.');
                        onOpenChange(false);
                      } catch (err) {
                        toast.error(describeError(err));
                      }
                    }}
                  >
                    Discard
                  </Button>
                  <Button
                    disabled={post.isPending}
                    data-testid="post-run"
                    onClick={async () => {
                      try {
                        const posted = await post.mutateAsync(r.id);
                        toast.success(`${posted.runNumber} posted (${posted.journalNumber}).`);
                      } catch (err) {
                        toast.error(describeError(err));
                      }
                    }}
                  >
                    Post
                  </Button>
                </>
              ) : null}
              {canRun && r.status === 'POSTED' ? (
                reversing ? (
                  <>
                    <Button variant="outline" onClick={() => setReversing(false)}>
                      Keep
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={reason.trim().length < 3 || reverse.isPending}
                      onClick={async () => {
                        try {
                          await reverse.mutateAsync({ id: r.id, reason: reason.trim() });
                          toast.success('Run reversed.');
                          setReversing(false);
                          setReason('');
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      Confirm reversal
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" onClick={() => setReversing(true)}>
                    Reverse
                  </Button>
                )
              ) : null}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
