'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, CheckCircle2, Clock, Play, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  P,
  RECONCILIATION_AREAS,
  SUBLEDGER_RECONCILIATION_STATUSES,
  type ReconciliationArea,
  type SubledgerReconciliationStatus,
} from '@accounting/types';
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
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAccountingPolicy,
  useReconciliationSummary,
  useReconciliations,
  useRunReconciliation,
  useUpdateAccountingPolicy,
} from '@/lib/api/reconciliation-hooks';
import type { ReconciliationAreaSummary, ReconciliationView } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';

export const AREA_LABEL: Record<ReconciliationArea, string> = {
  AR: 'Accounts receivable',
  AP: 'Accounts payable',
  INVENTORY: 'Inventory',
  FIXED_ASSETS: 'Fixed assets',
  TAX: 'Tax',
};

const STATUS_VARIANT: Record<
  SubledgerReconciliationStatus,
  'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
> = {
  NOT_STARTED: 'outline',
  IN_PROGRESS: 'secondary',
  RECONCILED: 'success',
  HAS_VARIANCE: 'destructive',
  UNDER_REVIEW: 'warning',
  APPROVED: 'success',
};

export function ReconciliationStatusBadge({ status }: { status: SubledgerReconciliationStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} data-testid="recon-status">
      {status.replace('_', ' ')}
    </Badge>
  );
}

export function ReconciliationCenterPage() {
  const router = useRouter();
  const { hasPermission } = useSession();
  const [asOf, setAsOf] = React.useState(today());
  const summary = useReconciliationSummary(asOf);
  const run = useRunReconciliation();
  const [policyOpen, setPolicyOpen] = React.useState(false);
  const table = useTableState({ pageSize: 25 });
  const [area, setArea] = React.useState<string>('ALL');
  const [status, setStatus] = React.useState<string>('ALL');
  const list = useReconciliations({
    ...table.query,
    area: area === 'ALL' ? undefined : (area as ReconciliationArea),
    status: status === 'ALL' ? undefined : (status as SubledgerReconciliationStatus),
  });
  const runArea = async (a: ReconciliationArea) => {
    try {
      const rec = await run.mutateAsync({ area: a, asOf });
      toast.success(
        `${AREA_LABEL[a]} reconciled as of ${asOf}: ${rec.status.replace('_', ' ').toLowerCase()}.`,
      );
      router.push(`/accounting/reconciliation/${rec.id}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const columns = React.useMemo<ColumnDef<ReconciliationView>[]>(
    () => [
      {
        id: 'area',
        header: 'Area',
        enableSorting: false,
        cell: ({ row }) => AREA_LABEL[row.original.area],
      },
      { id: 'asOf', header: 'As of', enableSorting: false, cell: ({ row }) => row.original.asOf },
      {
        id: 'control',
        header: 'Control account',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.controlAccountCode} {row.original.controlAccountName}
          </span>
        ),
      },
      {
        id: 'variance',
        header: () => <div className="text-right">Variance</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.variance} zeroAsDash />,
      },
      {
        id: 'exceptions',
        header: () => <div className="text-right">Open exc.</div>,
        enableSorting: false,
        cell: ({ row }) => <div className="text-right tabular">{row.original.openExceptions}</div>,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <ReconciliationStatusBadge status={row.original.status} />,
      },
      {
        id: 'who',
        header: 'Prepared / approved',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.preparedByName ?? '-'} · {row.original.approvedByName ?? 'not approved'}
          </span>
        ),
      },
      {
        id: 'computed',
        header: 'Computed',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatDateTime(row.original.computedAt)}
          </span>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Reconciliation center"
        description="Every subledger against its control account, plus each bank account against its latest statement. A variance is never closed silently: explain it, resolve it, approve it."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="recon-asof">As of</Label>
              <Input
                id="recon-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                data-testid="recon-asof"
              />
            </div>
            <Can permissions={[P['policy.manage']]}>
              <Button
                variant="outline"
                onClick={() => setPolicyOpen(true)}
                data-testid="recon-policy"
              >
                <Settings2 /> Policy
              </Button>
            </Can>
          </div>
        }
      />
      {!summary.data ? (
        <Skeleton className="h-48" />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Materiality: {formatMoney(summary.data.materiality)} · live figures as of{' '}
            {summary.data.asOf}
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {summary.data.areas.map((a) => (
              <AreaTile
                key={a.area}
                summary={a}
                canRun={hasPermission(P['reconciliation.prepare'])}
                running={run.isPending}
                onRun={() => runArea(a.area)}
              />
            ))}
          </div>
          <h2 className="mt-2 text-sm font-medium">Bank accounts</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {summary.data.banks.map((b) => {
              const open = b.unmatched + b.possible + b.exceptions;
              const ok = b.reconciliationStatus === 'COMPLETED' && open === 0;
              return (
                <Card key={b.bankAccountId} data-testid="bank-tile">
                  <CardContent className="space-y-1 p-4">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">
                        {b.code} {b.name}
                      </div>
                      {ok ? (
                        <CheckCircle2 className="h-5 w-5 text-success" />
                      ) : b.reconciliationStatus === 'NONE' ? (
                        <Clock className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <AlertTriangle className="h-5 w-5 text-warning" />
                      )}
                    </div>
                    <div className="text-sm">
                      Ledger balance:{' '}
                      <span className="tabular">{formatMoney(b.ledgerBalance, b.currency)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {b.lastStatementDate
                        ? `Last statement ${b.lastStatementDate} · ${b.reconciliationStatus.replace('_', ' ').toLowerCase()}`
                        : 'No statement imported'}
                      {open
                        ? ` · ${b.unmatched} unmatched, ${b.possible} to confirm, ${b.exceptions} exceptions`
                        : ''}
                    </div>
                    <div className="flex gap-2 pt-1">
                      {b.latestStatementId ? (
                        <Button size="sm" variant="outline" asChild>
                          <Link href={`/banking/reconciliation/${b.latestStatementId}`}>
                            Open statement
                          </Link>
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" asChild>
                          <Link href="/banking/reconciliation/import">Import statement</Link>
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {summary.data.banks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No bank accounts yet.</p>
            ) : null}
          </div>
        </>
      )}

      <h2 className="mt-4 text-sm font-medium">Recorded reconciliations</h2>
      <DataTable
        columns={columns}
        data={list.data}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/accounting/reconciliation/${r.id}`)}
        emptyState={
          <EmptyState
            title="Nothing recorded yet"
            description="Run an area above to record its reconciliation as of the chosen date."
          />
        }
        toolbar={
          <>
            <Select
              value={area}
              onValueChange={(v) => {
                setArea(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All areas</SelectItem>
                {RECONCILIATION_AREAS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {AREA_LABEL[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                <SelectItem value="ALL">All statuses</SelectItem>
                {SUBLEDGER_RECONCILIATION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <PolicyDialog open={policyOpen} onOpenChange={setPolicyOpen} />
    </>
  );
}

function AreaTile({
  summary,
  canRun,
  running,
  onRun,
}: {
  summary: ReconciliationAreaSummary;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
}) {
  const live = summary.live;
  const latest = summary.latest;
  return (
    <Card data-testid="recon-tile" data-area={summary.area}>
      <CardContent className="space-y-1 p-4">
        <div className="flex items-center justify-between">
          <div className="font-medium">{AREA_LABEL[summary.area]}</div>
          {live.withinMateriality ? (
            <CheckCircle2 className="h-5 w-5 text-success" aria-label="reconciled" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-destructive" aria-label="variance" />
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Subledger</div>
            <div className="tabular">{formatMoney(live.expected)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Ledger</div>
            <div className="tabular">{formatMoney(live.actual)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Variance</div>
            <div
              className={`tabular ${live.withinMateriality ? '' : 'font-semibold text-destructive'}`}
              data-testid="recon-live-variance"
            >
              {formatMoney(live.variance)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {latest ? (
            <>
              <ReconciliationStatusBadge status={latest.status} />
              <span>as of {latest.asOf}</span>
              {summary.stale ? <Badge variant="warning">stale</Badge> : null}
            </>
          ) : (
            <span>Never recorded</span>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          {canRun ? (
            <Button size="sm" onClick={onRun} disabled={running} data-testid="recon-run">
              <Play /> Run
            </Button>
          ) : null}
          {latest ? (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/accounting/reconciliation/${latest.id}`}>Open latest</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function PolicyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const policy = useAccountingPolicy();
  const update = useUpdateAccountingPolicy();
  const [materiality, setMateriality] = React.useState('');
  const [staleDays, setStaleDays] = React.useState('');
  React.useEffect(() => {
    if (policy.data) {
      setMateriality(policy.data.reconciliationMateriality);
      setStaleDays(String(policy.data.reconciliationStaleDays));
    }
  }, [policy.data, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Reconciliation policy</DialogTitle>
          <DialogDescription>
            Materiality is the absolute variance (base currency) up to which a reconciliation counts
            as reconciled; larger variances must be explained by resolved exceptions before
            approval.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="policy-materiality">Materiality</Label>
            <Input
              id="policy-materiality"
              inputMode="decimal"
              value={materiality}
              onChange={(e) => setMateriality(e.target.value)}
              data-testid="policy-materiality"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="policy-stale">Stale after (days)</Label>
            <Input
              id="policy-stale"
              inputMode="numeric"
              value={staleDays}
              onChange={(e) => setStaleDays(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={update.isPending}
            onClick={async () => {
              try {
                await update.mutateAsync({
                  reconciliationMateriality: materiality,
                  reconciliationStaleDays: Number(staleDays),
                });
                toast.success('Policy updated.');
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
            data-testid="policy-save"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
