'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
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
  Textarea,
  cn,
  type Tone,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useConsolidationAdjustments,
  useConsolidationGroups,
  useConsolidationRuns,
  useCreateConsolidationAdjustment,
  useCreateConsolidationRun,
  useDeleteConsolidationAdjustment,
  useFinalizeConsolidationRun,
  useGroupAccounts,
  useGroupReadiness,
  useGroupReport,
} from '@/lib/api/consolidation-hooks';
import type { GroupReport, ReadinessCheck } from '@/lib/api/types';
import { ConsolidationPage as QuickTrialBalance } from '@/components/enterprise/intercompany';
import { Can, EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';

const READINESS_TONE: Record<ReadinessCheck['status'], Tone> = {
  PASS: 'positive',
  WARN: 'warning',
  FAIL: 'critical',
};

/**
 * Group consolidation console (hardening H9): pick a group and window, read
 * the readiness checklist, the translated / eliminated / adjusted report,
 * book group-level adjustments and store or finalise runs. Every figure comes
 * from the consolidation API; the quick trial balance stays as its own tab.
 */
export function GroupConsolidationPage() {
  const groups = useConsolidationGroups();
  const [groupId, setGroupId] = React.useState<string | null>(null);
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const list = React.useMemo(() => groups.data ?? [], [groups.data]);
  const group = list.find((g) => g.id === groupId) ?? list[0] ?? null;
  React.useEffect(() => {
    if (!groupId && list[0]) setGroupId(list[0].id);
  }, [list, groupId]);
  const window = range.from && range.to ? { from: range.from, to: range.to } : null;

  return (
    <>
      <PageHeader
        title="Consolidation"
        description="Group consolidation: members translated at closing / average rates, mapped onto the group chart, intercompany eliminated, adjustments applied, CTA and non-controlling interests derived. Runs snapshot a consolidation; finalising needs every readiness check to pass."
        actions={
          <Can permissions={[P['consolidation.manage']]}>
            <Button variant="outline" asChild>
              <Link href="/admin/consolidation-groups">Manage groups</Link>
            </Button>
          </Can>
        }
      />
      <Tabs defaultValue="group">
        <TabsList>
          <TabsTrigger value="group" data-testid="consol-tab-group">
            Group consolidation
          </TabsTrigger>
          <TabsTrigger value="quick" data-testid="consol-tab-quick">
            Quick trial balance
          </TabsTrigger>
        </TabsList>
        <TabsContent value="group" className="space-y-3">
          {groups.isError ? (
            <ErrorState description={describeError(groups.error)} />
          ) : groups.isLoading ? (
            <TableSkeleton rows={4} />
          ) : list.length === 0 ? (
            <EmptyState
              title="No consolidation groups"
              description="Create a group (parent, members, presentation currency) under Administration → Consolidation groups."
            />
          ) : (
            <>
              <Card>
                <CardContent className="flex flex-wrap items-end gap-4 p-4">
                  <div className="space-y-1">
                    <Label htmlFor="consol-group">Group</Label>
                    <Select value={group?.id ?? ''} onValueChange={setGroupId}>
                      <SelectTrigger id="consol-group" className="w-72" data-testid="consol-group">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {list.map((g) => (
                          <SelectItem key={g.id} value={g.id}>
                            {g.code} · {g.name} ({g.presentationCurrency})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <DateRange from={range.from} to={range.to} onChange={setRange} />
                  {group ? (
                    <div className="mb-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                      {group.members.map((m) => (
                        <Badge key={m.companyId} variant={m.isParent ? 'default' : 'outline'}>
                          {m.code}{' '}
                          {m.isParent
                            ? 'parent'
                            : `${Number(m.ownershipPct)}% ${m.method.toLowerCase()}`}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
              {group && window ? (
                <Tabs defaultValue="report">
                  <TabsList>
                    <TabsTrigger value="report" data-testid="consol-tab-report">
                      Report
                    </TabsTrigger>
                    <TabsTrigger value="readiness" data-testid="consol-tab-readiness">
                      Readiness
                    </TabsTrigger>
                    <TabsTrigger value="adjustments" data-testid="consol-tab-adjustments">
                      Adjustments
                    </TabsTrigger>
                    <TabsTrigger value="runs" data-testid="consol-tab-runs">
                      Runs
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="report">
                    <ReportPanel groupId={group.id} window={window} />
                  </TabsContent>
                  <TabsContent value="readiness">
                    <ReadinessPanel groupId={group.id} window={window} />
                  </TabsContent>
                  <TabsContent value="adjustments">
                    <AdjustmentsPanel groupId={group.id} currency={group.presentationCurrency} />
                  </TabsContent>
                  <TabsContent value="runs">
                    <RunsPanel groupId={group.id} window={window} />
                  </TabsContent>
                </Tabs>
              ) : null}
            </>
          )}
        </TabsContent>
        <TabsContent value="quick">
          <QuickTrialBalance />
        </TabsContent>
      </Tabs>
    </>
  );
}

function ReportPanel({
  groupId,
  window,
}: {
  groupId: string;
  window: { from: string; to: string };
}) {
  const report = useGroupReport(groupId, window);
  if (report.isError) return <ErrorState description={describeError(report.error)} />;
  if (!report.data) return <TableSkeleton columns={6} rows={12} />;
  return <GroupReportView report={report.data} />;
}

export function GroupReportView({ report: r }: { report: GroupReport }) {
  const stat = (label: string, value: string, testId: string) => (
    <Card>
      <CardContent className="p-3">
        <div className="type-label text-muted-foreground">{label}</div>
        <div data-testid={testId}>
          <Amount value={value} currency={r.currency} className="text-left text-lg font-semibold" />
        </div>
      </CardContent>
    </Card>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {stat('Assets', r.totals.assets, 'consol-assets')}
        {stat('Liabilities', r.totals.liabilities, 'consol-liabilities')}
        {stat('Equity', r.totals.equity, 'consol-equity')}
        {stat('Net income', r.totals.netIncome, 'consol-net-income')}
        {stat('CTA', r.totals.cumulativeTranslationAdjustment, 'consol-cta')}
        {stat('Non-controlling interest', r.totals.nonControllingInterest, 'consol-nci')}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="consol-status">
        <StatusBadge tone={r.totals.balanced ? 'positive' : 'critical'}>
          {r.totals.balanced ? 'Balanced' : 'Not balanced'}
        </StatusBadge>
        <span className="text-muted-foreground">
          Elimination check {r.totals.eliminationCheck} · {r.adjustments.length} adjustment
          {r.adjustments.length === 1 ? '' : 's'} · {r.unmapped.length} unmapped
        </span>
        {r.members.map((m) => (
          <Badge
            key={m.companyId}
            variant="outline"
            title={`closing ${m.rates.closing} · average ${m.rates.average}`}
          >
            {m.code} {m.baseCurrency}
            {m.baseCurrency !== r.currency ? ` @ ${Number(m.rates.closing).toFixed(4)}` : ''}
            {m.cta !== '0.0000' ? ` · CTA ${m.cta}` : ''}
          </Badge>
        ))}
      </div>
      {r.unmapped.length ? (
        <Card>
          <CardContent className="p-3 text-sm">
            <span className="font-medium">Unmapped member accounts: </span>
            {r.unmapped
              .slice(0, 8)
              .map((u) => `${u.companyCode}:${u.code} ${u.name} (${u.balance})`)
              .join('; ')}
            {r.unmapped.length > 8 ? ` … +${r.unmapped.length - 8}` : ''}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table data-testid="consol-rows">
              <TableHeader>
                <TableRow>
                  <TableHead>Group account</TableHead>
                  {r.members.map((m) => (
                    <TableHead key={m.companyId} className="text-right">
                      {m.code}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Combined</TableHead>
                  <TableHead className="text-right">Eliminations</TableHead>
                  <TableHead className="text-right">Adjustments</TableHead>
                  <TableHead className="text-right">Consolidated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.rows.map((row) => (
                  <TableRow
                    key={row.groupAccountId ?? row.code}
                    data-testid="consol-row"
                    data-code={row.code}
                  >
                    <TableCell>
                      <span className="font-mono text-xs">{row.code}</span> {row.name}
                      {row.isIntercompany ? (
                        <Badge variant="outline" className="ml-2">
                          intercompany
                        </Badge>
                      ) : null}
                    </TableCell>
                    {r.members.map((m) => (
                      <TableCell key={m.companyId}>
                        <Amount
                          value={row.byCompany[m.companyId] ?? '0'}
                          currency={r.currency}
                          zeroAsDash
                        />
                      </TableCell>
                    ))}
                    <TableCell>
                      <Amount value={row.combined} currency={r.currency} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={row.eliminations} currency={r.currency} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={row.adjustments} currency={r.currency} zeroAsDash />
                    </TableCell>
                    <TableCell className={cn('font-medium')}>
                      <Amount value={row.consolidated} currency={r.currency} zeroAsDash />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ReadinessPanel({
  groupId,
  window,
}: {
  groupId: string;
  window: { from: string; to: string };
}) {
  const readiness = useGroupReadiness(groupId, window);
  if (readiness.isError) return <ErrorState description={describeError(readiness.error)} />;
  if (!readiness.data) return <TableSkeleton rows={8} />;
  const r = readiness.data;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <CardTitle className="mr-auto">
          Readiness for {r.from} – {r.to}
        </CardTitle>
        <StatusBadge tone={r.ready ? 'positive' : 'critical'} data-testid="consol-ready">
          {r.ready ? 'Ready to finalise' : 'Not ready'}
        </StatusBadge>
      </CardHeader>
      <CardContent className="p-0">
        <Table data-testid="consol-readiness">
          <TableBody>
            {r.checks.map((c) => (
              <TableRow
                key={c.key}
                data-testid="consol-check"
                data-key={c.key}
                data-status={c.status}
              >
                <TableCell className="w-40">
                  <StatusBadge tone={READINESS_TONE[c.status]}>{c.status}</StatusBadge>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{c.title}</div>
                  <div className="text-xs text-muted-foreground">{c.detail}</div>
                  {c.items?.length ? (
                    <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                      {c.items.slice(0, 5).map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AdjustmentsPanel({ groupId, currency }: { groupId: string; currency: string }) {
  const adjustments = useConsolidationAdjustments(groupId);
  const remove = useDeleteConsolidationAdjustment();
  const [adding, setAdding] = React.useState(false);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <CardTitle className="mr-auto">Group adjustments</CardTitle>
        <Can permissions={[P['consolidation.manage']]}>
          <Button size="sm" onClick={() => setAdding(true)} data-testid="consol-adj-add">
            <Plus /> New adjustment
          </Button>
        </Can>
      </CardHeader>
      <CardContent className="p-0">
        {adjustments.isError ? (
          <ErrorState description={describeError(adjustments.error)} />
        ) : !adjustments.data ? (
          <TableSkeleton rows={4} />
        ) : adjustments.data.length === 0 ? (
          <EmptyState
            className="border-0"
            title="No adjustments"
            description="Investment eliminations, unrealised profit and reclassifications are booked here at group level; they never touch a company ledger."
          />
        ) : (
          <Table data-testid="consol-adjustments">
            <TableHeader>
              <TableRow>
                <TableHead>Effective</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Lines</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustments.data.map((a) => (
                <TableRow key={a.id} data-testid="consol-adjustment">
                  <TableCell className="text-xs">
                    {a.effectiveDate}
                    {a.recurringUntil ? (
                      <div className="text-muted-foreground">until {a.recurringUntil}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{a.reference ?? '-'}</TableCell>
                  <TableCell>{a.description}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.lines.map((l) => (
                      <div key={l.id}>
                        {l.groupAccountCode}{' '}
                        {Number(l.debit) > 0 ? `Dr ${l.debit}` : `Cr ${l.credit}`}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell>
                    <Amount value={a.total} currency={currency} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Can permissions={[P['consolidation.manage']]}>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Delete"
                        onClick={() =>
                          remove.mutate(
                            { groupId, id: a.id },
                            { onError: (e) => toast.error(describeError(e)) },
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {adding ? <AdjustmentDialog groupId={groupId} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

function AdjustmentDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const accounts = useGroupAccounts(groupId);
  const create = useCreateConsolidationAdjustment();
  const [effectiveDate, setEffectiveDate] = React.useState(today());
  const [reference, setReference] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [lines, setLines] = React.useState([
    { groupAccountId: '', debit: '', credit: '' },
    { groupAccountId: '', debit: '', credit: '' },
  ]);
  const setLine = (i: number, patch: Partial<(typeof lines)[number]>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const sum = (k: 'debit' | 'credit') => lines.reduce((n, l) => n + (Number(l[k]) || 0), 0);
  const balanced = sum('debit') > 0 && Math.abs(sum('debit') - sum('credit')) < 0.00005;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New group adjustment</DialogTitle>
          <DialogDescription>
            Booked in the presentation currency on group accounts; applies to windows containing the
            effective date. Lines must balance.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="adj-date">Effective date</Label>
            <Input
              id="adj-date"
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              data-testid="consol-adj-date"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adj-ref">Reference</Label>
            <Input
              id="adj-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              data-testid="consol-adj-ref"
            />
          </div>
          <div className="space-y-1 sm:col-span-3">
            <Label htmlFor="adj-desc">Description</Label>
            <Textarea
              id="adj-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="consol-adj-desc"
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Group account</TableHead>
              <TableHead className="w-36 text-right">Debit</TableHead>
              <TableHead className="w-36 text-right">Credit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => (
              <TableRow key={i} data-testid="consol-adj-line">
                <TableCell>
                  <Select
                    value={l.groupAccountId}
                    onValueChange={(v) => setLine(i, { groupAccountId: v })}
                  >
                    <SelectTrigger data-testid="consol-adj-account">
                      <SelectValue placeholder="Select group account" />
                    </SelectTrigger>
                    <SelectContent>
                      {(accounts.data ?? []).map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.code} {g.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Input
                    inputMode="decimal"
                    value={l.debit}
                    onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })}
                    className="text-right"
                    data-testid="consol-adj-debit"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    inputMode="decimal"
                    value={l.credit}
                    onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })}
                    className="text-right"
                    data-testid="consol-adj-credit"
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLines((ls) => [...ls, { groupAccountId: '', debit: '', credit: '' }])}
          >
            <Plus /> Add line
          </Button>
          <span
            className={cn(balanced ? 'text-positive' : 'text-muted-foreground')}
            data-testid="consol-adj-balance"
          >
            Dr {sum('debit').toFixed(2)} · Cr {sum('credit').toFixed(2)}{' '}
            {balanced ? '· balanced' : ''}
          </span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !balanced || !description || create.isPending || lines.some((l) => !l.groupAccountId)
            }
            data-testid="consol-adj-save"
            onClick={() =>
              create.mutate(
                {
                  groupId,
                  effectiveDate,
                  reference: reference || undefined,
                  description,
                  lines: lines.map((l) => ({
                    groupAccountId: l.groupAccountId,
                    debit: l.debit || '0',
                    credit: l.credit || '0',
                  })),
                },
                {
                  onSuccess: () => {
                    toast.success('Adjustment booked');
                    onClose();
                  },
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <Save /> Book adjustment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunsPanel({ groupId, window }: { groupId: string; window: { from: string; to: string } }) {
  const runs = useConsolidationRuns(groupId);
  const create = useCreateConsolidationRun();
  const finalize = useFinalizeConsolidationRun();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <CardTitle className="mr-auto">Consolidation runs</CardTitle>
        <Can permissions={[P['consolidation.manage']]}>
          <Button
            size="sm"
            disabled={create.isPending}
            data-testid="consol-run-create"
            onClick={() =>
              create.mutate(
                { groupId, ...window },
                {
                  onSuccess: (r) =>
                    toast.success(
                      `Run stored for ${r.fromDate} – ${r.toDate} (${r.readiness.ready ? 'ready' : 'not ready'})`,
                    ),
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <Plus /> Store run for {window.from} – {window.to}
          </Button>
        </Can>
      </CardHeader>
      <CardContent className="p-0">
        {runs.isError ? (
          <ErrorState description={describeError(runs.error)} />
        ) : !runs.data ? (
          <TableSkeleton rows={4} />
        ) : runs.data.items.length === 0 ? (
          <EmptyState
            className="border-0"
            title="No runs yet"
            description="Store a run to keep a reproducible snapshot; finalise it once every readiness check passes."
          />
        ) : (
          <Table data-testid="consol-runs">
            <TableHeader>
              <TableRow>
                <TableHead>Window</TableHead>
                <TableHead>Stored</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Readiness</TableHead>
                <TableHead className="text-right">Net income</TableHead>
                <TableHead className="text-right">CTA</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.items.map((r) => (
                <TableRow key={r.id} data-testid="consol-run" data-status={r.status}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {r.fromDate} – {r.toDate}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(r.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={r.status === 'FINAL' ? 'positive' : 'pending'}>
                      {r.status}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={r.readiness.ready ? 'positive' : 'critical'}>
                      {r.readiness.ready
                        ? 'ready'
                        : `${r.readiness.checks.filter((c) => c.status === 'FAIL').length} failing`}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <Amount value={r.totals.netIncome} currency={r.currency} />
                  </TableCell>
                  <TableCell>
                    <Amount
                      value={r.totals.cumulativeTranslationAdjustment}
                      currency={r.currency}
                      zeroAsDash
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === 'DRAFT' ? (
                      <Can permissions={[P['consolidation.manage']]}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!r.readiness.ready || finalize.isPending}
                          title={
                            r.readiness.ready ? 'Finalise' : 'Every readiness check must pass first'
                          }
                          data-testid="consol-run-finalize"
                          onClick={() =>
                            finalize.mutate(
                              { groupId, runId: r.id },
                              {
                                onSuccess: () => toast.success('Consolidation finalised'),
                                onError: (e) => toast.error(describeError(e)),
                              },
                            )
                          }
                        >
                          <Lock /> Finalise
                        </Button>
                      </Can>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckCircle2 className="h-3 w-3" />{' '}
                        {r.finalizedAt ? new Date(r.finalizedAt).toLocaleDateString() : ''}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
