'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Layers, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@accounting/money';
import { CONSOLIDATION_RUN_STATUSES, P } from '@accounting/types';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StepTimeline,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type TimelineStep,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAddConsolidationAdjustment,
  useConsolidatedStatements,
  useConsolidationRun,
  useConsolidationRunAction,
  useConsolidationRuns,
  useVoidConsolidationAdjustment,
} from '@/lib/api/consolidation-hooks';
import type {
  ConsolidatedRow,
  ConsolidationRun,
  ConsolidationRunSummary,
  StatementLine,
} from '@/lib/api/consolidation-types';
import { formatDateTime, titleCase } from '@/lib/format';
import { APPROVAL_STEPS, OperationDialog } from '@/components/accounting/operation-dialog';
import { Amount } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import {
  DescriptionList,
  Field,
  Kpi,
  ReasonDialog,
  StatusBadge,
} from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';

// ------------------------------------------------------------------- list

export function ConsolidationRunsPage() {
  const router = useAppRouter();
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const runs = useConsolidationRuns({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as ConsolidationRunSummary['status']),
  });
  const columns = React.useMemo<ColumnDef<ConsolidationRunSummary>[]>(
    () => [
      {
        id: 'number',
        header: 'Run',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-mono text-sm">{row.original.documentNumber}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.description ?? row.original.groupName}
            </div>
          </div>
        ),
      },
      {
        id: 'group',
        header: 'Group',
        enableSorting: false,
        cell: ({ row }) => row.original.groupCode,
      },
      {
        id: 'period',
        header: 'Period',
        enableSorting: false,
        cell: ({ row }) => `${row.original.periodStart} to ${row.original.periodEnd}`,
      },
      {
        id: 'adj',
        header: 'Adjustments',
        enableSorting: false,
        cell: ({ row }) => row.original.adjustmentCount,
      },
      {
        id: 'finalized',
        header: 'Finalized',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.finalizedAt ? formatDateTime(row.original.finalizedAt) : '-',
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Consolidation Runs"
        description="Fiscal-year-to-date group closes: member ledgers translated, eliminations applied, adjustments reviewed, then finalized by a second person."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/consolidation/groups">
              <Plus /> New run (from a group)
            </Link>
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={runs.data}
        isLoading={runs.isLoading}
        isFetching={runs.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/consolidation/runs/${r.id}`)}
        emptyState={
          <EmptyState
            icon={Layers}
            title="No consolidation runs"
            description="Open a run from a consolidation group."
          />
        }
        toolbar={
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
              {CONSOLIDATION_RUN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </>
  );
}

// ----------------------------------------------------------------- detail

function timeline(r: ConsolidationRun): TimelineStep[] {
  const meta = (when: string | null) => (when ? formatDateTime(when) : undefined);
  const steps: TimelineStep[] = [
    { key: 'opened', label: 'Opened', state: 'complete', meta: meta(r.createdAt) },
    {
      key: 'prepared',
      label: 'Prepared from member ledgers',
      state: r.preparedAt ? 'complete' : 'current',
      meta: meta(r.preparedAt),
    },
    {
      key: 'finalized',
      label: 'Finalized (group close)',
      state: r.status === 'FINALIZED' ? 'complete' : r.preparedAt ? 'current' : 'upcoming',
      meta: meta(r.finalizedAt),
      description: r.finalizeNote ?? undefined,
    },
  ];
  if (r.reopenedAt && r.status === 'DRAFT')
    steps.push({
      key: 'reopened',
      label: 'Reopened',
      state: 'failed',
      meta: meta(r.reopenedAt),
      description: r.reopenReason ?? undefined,
    });
  return steps;
}

export function ConsolidationRunDetailPage({ id }: { id: string }) {
  const run = useConsolidationRun(id);
  const statements = useConsolidatedStatements(id);
  const action = useConsolidationRunAction();
  const voidAdj = useVoidConsolidationAdjustment();
  const [pending, setPending] = React.useState<'finalize' | 'reopen' | 'adjust' | null>(null);
  const [voiding, setVoiding] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');
  return (
    <QueryState query={run}>
      {(r) => {
        const c = r.currency;
        const draft = r.status === 'DRAFT';
        const blockers = r.readiness.items.filter((i) => i.blocking && !i.ok);
        return (
          <>
            <PageHeader
              title={r.documentNumber}
              description={
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={r.status} /> {r.groupCode} {r.groupName} - {r.periodStart} to{' '}
                  {r.periodEnd} - {c}
                </span>
              }
              actions={
                <>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/consolidation/groups/${r.groupId}`}>
                      <ArrowLeft /> Group
                    </Link>
                  </Button>
                  {draft ? (
                    <Can permissions={[P['consolidation.run']]}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={action.isPending}
                        onClick={async () => {
                          try {
                            await action.mutateAsync({ id, action: 'prepare' });
                            toast.success('Re-prepared from the member ledgers.');
                          } catch (err) {
                            toast.error(describeError(err));
                          }
                        }}
                      >
                        <RefreshCw /> Re-prepare
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setPending('adjust')}>
                        <Plus /> Adjustment
                      </Button>
                    </Can>
                  ) : null}
                  {draft ? (
                    <Can permissions={[P['consolidation.approve']]}>
                      <Button
                        size="sm"
                        disabled={!r.readiness.ready || !r.totals.balanced}
                        onClick={() => setPending('finalize')}
                      >
                        Finalize
                      </Button>
                    </Can>
                  ) : (
                    <Can permissions={[P['consolidation.approve']]}>
                      <Button size="sm" variant="outline" onClick={() => setPending('reopen')}>
                        Reopen
                      </Button>
                    </Can>
                  )}
                </>
              }
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Kpi label="Total assets" value={r.totals.assets} currency={c} />
              <Kpi
                label="Net income"
                value={r.totals.netIncome}
                currency={c}
                hint={`${formatMoney(r.totals.profitAttributableToParent, c)} to the parent`}
              />
              <Kpi
                label="Non-controlling interest"
                value={r.totals.nonControllingInterest}
                currency={c}
                hint={`+ ${formatMoney(r.totals.profitAttributableToNci, c)} share of profit`}
              />
              <Kpi
                label="Translation adjustment"
                value={r.totals.translationAdjustment}
                currency={c}
              />
              <Kpi
                label="Balanced"
                value={r.totals.balanced ? 'Yes' : `Out by ${formatMoney(r.totals.difference, c)}`}
                raw
                tone={r.totals.balanced ? 'success' : 'danger'}
                hint={`${r.adjustmentCount} active adjustment(s)`}
              />
            </div>
            {draft && blockers.length ? (
              <Card className="border-warning/60">
                <CardHeader>
                  <CardTitle className="text-sm">Group close blocked</CardTitle>
                  <CardDescription>
                    {blockers
                      .map((b) => `${b.label}${b.detail ? ` - ${b.detail}` : ''}`)
                      .join('; ')}
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : null}
            <Tabs defaultValue="tb">
              <TabsList>
                <TabsTrigger value="tb">Trial balance</TabsTrigger>
                <TabsTrigger value="statements">Statements</TabsTrigger>
                <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
                <TabsTrigger value="members">Members and rates</TabsTrigger>
              </TabsList>
              <TabsContent value="tb">
                <TrialBalanceCard run={r} />
              </TabsContent>
              <TabsContent value="statements">
                <QueryState query={statements}>
                  {(s) => (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <StatementCard
                        title="Consolidated balance sheet"
                        currency={c}
                        sections={[
                          {
                            label: 'Assets',
                            lines: s.balanceSheet.assets,
                            total: s.balanceSheet.totals.assets,
                          },
                          {
                            label: 'Liabilities',
                            lines: s.balanceSheet.liabilities,
                            total: s.balanceSheet.totals.liabilities,
                          },
                          {
                            label: 'Equity',
                            lines: s.balanceSheet.equity,
                            total: s.balanceSheet.totals.equity,
                          },
                        ]}
                        footer={[
                          [
                            'Current earnings attributable to the parent',
                            s.balanceSheet.totals.currentEarnings,
                          ],
                          ['Liabilities and equity', s.balanceSheet.totals.liabilitiesAndEquity],
                          [
                            'Of which non-controlling interest',
                            s.balanceSheet.totals.nonControllingInterest,
                          ],
                        ]}
                      />
                      <StatementCard
                        title="Consolidated income statement"
                        currency={c}
                        sections={[
                          {
                            label: 'Revenue',
                            lines: s.incomeStatement.revenue,
                            total: s.incomeStatement.totals.revenue,
                          },
                          {
                            label: 'Cost of sales',
                            lines: s.incomeStatement.costOfSales,
                            total: s.incomeStatement.totals.costOfSales,
                          },
                          {
                            label: 'Expenses',
                            lines: s.incomeStatement.expenses,
                            total: s.incomeStatement.totals.expenses,
                          },
                        ]}
                        footer={[
                          ['Gross profit', s.incomeStatement.totals.grossProfit],
                          ['Net income', s.incomeStatement.totals.netIncome],
                          [
                            'Attributable to non-controlling interest',
                            s.incomeStatement.totals.attributableToNci,
                          ],
                          [
                            'Attributable to the parent',
                            s.incomeStatement.totals.attributableToParent,
                          ],
                        ]}
                      />
                    </div>
                  )}
                </QueryState>
              </TabsContent>
              <TabsContent value="adjustments">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Consolidation ledger</CardTitle>
                    <CardDescription>
                      Rule-driven entries are regenerated on every preparation; manual ones stay
                      until voided. Nothing here touches a member&apos;s books.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {r.adjustments.map((a) => (
                      <div
                        key={a.id}
                        className={`rounded-md border ${a.status === 'VOID' ? 'opacity-60' : ''}`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                          <div>
                            <span className="font-mono text-xs">#{a.sequence}</span>{' '}
                            <span className="text-sm font-medium">{a.description}</span>
                            <div className="text-xs text-muted-foreground">
                              {titleCase(a.type)}{' '}
                              {a.ruleCode
                                ? `- rule ${a.ruleCode}`
                                : a.autoGenerated
                                  ? ''
                                  : '- manual'}{' '}
                              {a.reference ? `- ${a.reference}` : ''}
                              {a.voidReason ? ` - void: ${a.voidReason}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={a.status} />
                            {draft && a.status === 'ACTIVE' ? (
                              <Can permissions={[P['consolidation.run']]}>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Void adjustment ${a.sequence}`}
                                  onClick={() => setVoiding(a.id)}
                                >
                                  <Trash2 />
                                </Button>
                              </Can>
                            ) : null}
                          </div>
                        </div>
                        <Table>
                          <TableBody>
                            {a.lines.map((l) => (
                              <TableRow key={l.id}>
                                <TableCell className="w-28 font-mono text-xs">
                                  {l.accountCode}
                                </TableCell>
                                <TableCell className="text-xs">
                                  {l.accountName}
                                  {l.companyId ? (
                                    <span className="ml-1 text-muted-foreground">
                                      (
                                      {r.members.find((m) => m.companyId === l.companyId)?.code ??
                                        'member'}
                                      )
                                    </span>
                                  ) : (
                                    <span className="ml-1 text-muted-foreground">(group)</span>
                                  )}
                                  {l.description ? (
                                    <div className="text-muted-foreground">{l.description}</div>
                                  ) : null}
                                </TableCell>
                                <TableCell className="w-32">
                                  <Amount value={l.debit} currency={c} zeroAsDash />
                                </TableCell>
                                <TableCell className="w-32">
                                  <Amount value={l.credit} currency={c} zeroAsDash />
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ))}
                    {!r.adjustments.length ? (
                      <p className="text-sm text-muted-foreground">
                        No adjustments: the group is the sum of its members.
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="members">
                <div className="grid gap-4 lg:grid-cols-3">
                  <Card className="lg:col-span-2">
                    <CardHeader>
                      <CardTitle className="text-sm">Members and translation rates</CardTitle>
                      <CardDescription>
                        Member currency to {c}: closing for the balance sheet, average for profit
                        and loss, historical for equity.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead>Entity</TableHead>
                            <TableHead>Method</TableHead>
                            <TableHead className="text-right">Closing</TableHead>
                            <TableHead className="text-right">Average</TableHead>
                            <TableHead className="text-right">Historical</TableHead>
                            <TableHead className="text-right">Net income</TableHead>
                            <TableHead className="text-right">CTA</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {r.members.map((m) => (
                            <TableRow key={m.companyId}>
                              <TableCell>
                                <div className="font-medium">{m.code}</div>
                                <div className="text-xs text-muted-foreground">
                                  {m.name} - {m.currency}
                                </div>
                              </TableCell>
                              <TableCell className="text-xs">
                                {titleCase(m.method)} {Number(m.ownershipPercent)}%
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {m.rates.closing}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {m.rates.average}
                              </TableCell>
                              <TableCell className="text-right font-mono text-xs">
                                {m.rates.historical}
                              </TableCell>
                              <TableCell>
                                <Amount value={m.netIncome} currency={c} />
                              </TableCell>
                              <TableCell>
                                <Amount value={m.translationAdjustment} currency={c} zeroAsDash />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Lifecycle</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <StepTimeline steps={timeline(r)} />
                      <DescriptionList
                        items={r.readiness.items.map((i) => [
                          i.label,
                          <StatusBadge
                            key={i.key}
                            status={i.ok ? 'OK' : i.blocking ? 'CRITICAL' : 'WARNING'}
                          />,
                        ])}
                      />
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </Tabs>

            <OperationDialog
              open={pending === 'finalize'}
              onOpenChange={(o) => !o && setPending(null)}
              title={`Finalize ${r.documentNumber}`}
              description="Freezes the member figures for this group close. Four-eyes: the finalizer must not be the preparer. Reopen later to change anything."
              confirmLabel="Finalize"
              loadingLabel="Finalizing..."
              resultLabel="Finalized"
              steps={APPROVAL_STEPS}
              run={() =>
                action.mutateAsync({ id, action: 'finalize', body: { note: note || undefined } })
              }
            >
              <Field label="Note">
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Board pack, August 2026"
                />
              </Field>
            </OperationDialog>
            <ReasonDialog
              open={pending === 'reopen'}
              onOpenChange={(o) => !o && setPending(null)}
              title={`Reopen ${r.documentNumber}`}
              description="The frozen figures are discarded; re-prepare to read the member ledgers again."
              confirmLabel="Reopen"
              destructive
              loading={action.isPending}
              onConfirm={async (reason) => {
                try {
                  await action.mutateAsync({ id, action: 'reopen', body: { reason } });
                  toast.success('Run reopened.');
                  setPending(null);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            />
            <ReasonDialog
              open={voiding !== null}
              onOpenChange={(o) => !o && setVoiding(null)}
              title="Void adjustment"
              confirmLabel="Void"
              destructive
              loading={voidAdj.isPending}
              onConfirm={async (reason) => {
                try {
                  await voidAdj.mutateAsync({ runId: id, adjustmentId: voiding!, reason });
                  toast.success('Adjustment voided.');
                  setVoiding(null);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            />
            <AdjustmentDialog
              run={r}
              open={pending === 'adjust'}
              onOpenChange={(o) => !o && setPending(null)}
            />
          </>
        );
      }}
    </QueryState>
  );
}

function TrialBalanceCard({ run: r }: { run: ConsolidationRun }) {
  const c = r.currency;
  const columns = r.members;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Consolidated trial balance</CardTitle>
        <CardDescription>
          Members translated to {c}, combined, then the consolidation ledger applied.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              {columns.map((m) => (
                <TableHead key={m.companyId} className="text-right">
                  {m.code}
                </TableHead>
              ))}
              <TableHead className="text-right">Combined</TableHead>
              <TableHead className="text-right">Adjustments</TableHead>
              <TableHead className="text-right">Consolidated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.rows.map((row) => (
              <TableRow key={row.code} className={row.isIntercompany ? 'bg-muted/30' : undefined}>
                <TableCell>
                  <span className="font-mono text-xs">{row.code}</span>{' '}
                  <span className="text-sm">{row.name}</span>
                  {row.isIntercompany ? (
                    <span className="ml-1 text-xs text-muted-foreground">IC</span>
                  ) : null}
                </TableCell>
                {columns.map((m) => (
                  <TableCell key={m.companyId}>
                    <Amount value={row.byCompany[m.companyId] ?? '0'} currency={c} zeroAsDash />
                  </TableCell>
                ))}
                <TableCell>
                  <Amount value={row.combined} currency={c} zeroAsDash />
                </TableCell>
                <TableCell>
                  <Amount
                    value={row.adjustments}
                    currency={c}
                    zeroAsDash
                    className={row.adjustments !== '0.0000' ? 'text-warning' : undefined}
                  />
                </TableCell>
                <TableCell>
                  <Amount value={row.consolidated} currency={c} className="font-medium" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function StatementCard({
  title,
  currency,
  sections,
  footer,
}: {
  title: string;
  currency: string;
  sections: Array<{ label: string; lines: StatementLine[]; total: string }>;
  footer: Array<[string, string]>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {sections.map((s) => (
              <React.Fragment key={s.label}>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell className="font-medium">{s.label}</TableCell>
                  <TableCell>
                    <Amount value={s.total} currency={currency} className="font-medium" />
                  </TableCell>
                </TableRow>
                {s.lines.map((l) => (
                  <React.Fragment key={l.key}>
                    <TableRow>
                      <TableCell className="pl-6 text-sm">{l.label}</TableCell>
                      <TableCell>
                        <Amount value={l.amount} currency={currency} />
                      </TableCell>
                    </TableRow>
                    {(l.rows ?? []).map((r: ConsolidatedRow) => (
                      <TableRow key={r.code} className="text-xs text-muted-foreground">
                        <TableCell className="pl-10">
                          <span className="font-mono">{r.code}</span> {r.name}
                        </TableCell>
                        <TableCell>
                          <Amount
                            value={r.consolidated}
                            currency={currency}
                            className="text-muted-foreground"
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </React.Fragment>
                ))}
              </React.Fragment>
            ))}
            {footer.map(([label, value]) => (
              <TableRow key={label} className="border-t hover:bg-transparent">
                <TableCell className="font-medium">{label}</TableCell>
                <TableCell>
                  <Amount value={value} currency={currency} className="font-semibold" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

interface LineDraft {
  accountCode: string;
  companyId: string;
  debit: string;
  credit: string;
  description: string;
}

function AdjustmentDialog({
  run: r,
  open,
  onOpenChange,
}: {
  run: ConsolidationRun;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const add = useAddConsolidationAdjustment();
  const [description, setDescription] = React.useState('');
  const [reference, setReference] = React.useState('');
  const [lines, setLines] = React.useState<LineDraft[]>([
    { accountCode: '', companyId: 'GROUP', debit: '', credit: '', description: '' },
    { accountCode: '', companyId: 'GROUP', debit: '', credit: '', description: '' },
  ]);
  const totals = lines.reduce(
    (t, l) => ({ debit: t.debit + Number(l.debit || 0), credit: t.credit + Number(l.credit || 0) }),
    { debit: 0, credit: 0 },
  );
  const balanced = Math.abs(totals.debit - totals.credit) < 0.00005 && totals.debit > 0;
  const set = (i: number, patch: Partial<LineDraft>) =>
    setLines((p) => p.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manual consolidation adjustment</DialogTitle>
          <DialogDescription>
            Posts to the group&apos;s consolidation ledger only - by account code, in {r.currency}.
            Debits must equal credits.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Adjustment description"
            />
          </Field>
          <Field label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[6rem_1fr_7rem_7rem_2.5rem]">
              <Input
                placeholder="Code"
                value={l.accountCode}
                onChange={(e) => set(i, { accountCode: e.target.value })}
                aria-label={`Line ${i + 1} account code`}
              />
              <Select value={l.companyId} onValueChange={(v) => set(i, { companyId: v })}>
                <SelectTrigger aria-label={`Line ${i + 1} column`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GROUP">Group column</SelectItem>
                  {r.members.map((m) => (
                    <SelectItem key={m.companyId} value={m.companyId}>
                      {m.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                inputMode="decimal"
                placeholder="Debit"
                value={l.debit}
                onChange={(e) => set(i, { debit: e.target.value })}
                aria-label={`Line ${i + 1} debit`}
              />
              <Input
                inputMode="decimal"
                placeholder="Credit"
                value={l.credit}
                onChange={(e) => set(i, { credit: e.target.value })}
                aria-label={`Line ${i + 1} credit`}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove line"
                disabled={lines.length <= 2}
                onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setLines((p) => [
                  ...p,
                  { accountCode: '', companyId: 'GROUP', debit: '', credit: '', description: '' },
                ])
              }
            >
              <Plus /> Line
            </Button>
            <span className={`text-sm ${balanced ? 'text-positive' : 'text-warning'}`}>
              Dr {totals.debit.toFixed(2)} / Cr {totals.credit.toFixed(2)}
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !description || !balanced || lines.some((l) => !l.accountCode) || add.isPending
            }
            onClick={async () => {
              try {
                await add.mutateAsync({
                  runId: r.id,
                  type: 'MANUAL',
                  description,
                  reference: reference || undefined,
                  lines: lines.map((l) => ({
                    accountCode: l.accountCode,
                    companyId: l.companyId === 'GROUP' ? null : l.companyId,
                    debit: l.debit || undefined,
                    credit: l.credit || undefined,
                    description: l.description || undefined,
                  })),
                });
                toast.success('Adjustment posted to the consolidation ledger.');
                onOpenChange(false);
                setDescription('');
                setLines([
                  { accountCode: '', companyId: 'GROUP', debit: '', credit: '', description: '' },
                  { accountCode: '', companyId: 'GROUP', debit: '', credit: '', description: '' },
                ]);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Post adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
