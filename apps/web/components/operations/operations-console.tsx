'use client';
import * as React from 'react';
import { Play, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  HealthIndicator,
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
  type Tone,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useDiscardFailed,
  useFailedJobs,
  useIntegrityRuns,
  useJobRuns,
  useJobs,
  useQueueStats,
  useRetryFailed,
  useRunIntegrityCheck,
  useRunJob,
  useRuntimeStatus,
} from '@/lib/api/operations-hooks';
import type { IntegrityRunView, JobRunView } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';

const RUN_TONE: Record<JobRunView['status'], Tone> = {
  RUNNING: 'pending',
  SUCCEEDED: 'positive',
  FAILED: 'critical',
  SKIPPED_LOCKED: 'neutral',
};
const INTEGRITY_TONE: Record<IntegrityRunView['status'], Tone> = {
  OK: 'positive',
  WARNING: 'warning',
  CRITICAL: 'critical',
  FAILED: 'critical',
};

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '-');
/** "every 300000 ms" -> "every 5 min"; cron patterns pass through. */
const humanSchedule = (schedule: string | null) => {
  const m = schedule && /^every (d+) ms$/.exec(schedule);
  if (!m) return schedule;
  const ms = Number(m[1]);
  if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `every ${ms / 60_000} min`;
  return `every ${ms / 1000} s`;
};
const duration = (ms: number | null) =>
  ms === null ? '-' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

/**
 * Operations console (hardening H8): runtime status, background jobs with
 * manual triggers, queue dead letters and scheduled integrity outcomes.
 * Everything shown is read from the operations API; nothing here touches
 * business data.
 */
export function OperationsConsole() {
  return (
    <>
      <PageHeader
        title="Operations"
        description="Runtime health, background jobs, queue dead letters and the nightly integrity checks. Manual runs and retries are audited."
      />
      <StatusCards />
      <Tabs defaultValue="jobs">
        <TabsList>
          <TabsTrigger value="jobs" data-testid="ops-tab-jobs">
            Jobs
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="ops-tab-runs">
            Run history
          </TabsTrigger>
          <TabsTrigger value="queues" data-testid="ops-tab-queues">
            Queues
          </TabsTrigger>
          <TabsTrigger value="integrity" data-testid="ops-tab-integrity">
            Integrity runs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="jobs">
          <JobsPanel />
        </TabsContent>
        <TabsContent value="runs">
          <RunsPanel />
        </TabsContent>
        <TabsContent value="queues">
          <QueuesPanel />
        </TabsContent>
        <TabsContent value="integrity">
          <IntegrityPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}

function StatusCards() {
  const status = useRuntimeStatus();
  if (status.isError) return <ErrorState description={describeError(status.error)} />;
  const s = status.data;
  if (!s) return <TableSkeleton rows={2} />;
  const migrations = 'error' in s.migrations ? null : s.migrations;
  const overall: { tone: Tone; label: string } = s.draining
    ? { tone: 'warning', label: 'Draining' }
    : !s.database.ok || (migrations && migrations.pending.length > 0) || !s.storage.writable
      ? { tone: 'critical', label: 'Not ready' }
      : !s.redis.ok
        ? { tone: 'warning', label: 'Degraded (no queues)' }
        : { tone: 'positive', label: 'Healthy' };
  const card = (label: string, value: React.ReactNode, testId: string, hint?: React.ReactNode) => (
    <Card>
      <CardContent className="p-4">
        <div className="type-label text-muted-foreground">{label}</div>
        <div className="mt-1 text-lg font-semibold" data-testid={testId}>
          {value}
        </div>
        {hint ? (
          <div
            className="truncate text-xs text-muted-foreground"
            title={typeof hint === 'string' ? hint : undefined}
          >
            {hint}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="ops-status">
      <Card>
        <CardContent className="p-4">
          <HealthIndicator
            tone={overall.tone}
            label={overall.label}
            description={`v${s.version} · ${s.environment} · up ${Math.floor(s.uptimeSeconds / 60)} min`}
          />
        </CardContent>
      </Card>
      {card(
        'Database',
        s.database.ok ? `${s.database.latencyMs} ms` : 'Unreachable',
        'ops-db',
        `pool ${s.database.pool.idle}/${s.database.pool.total} idle, ${s.database.pool.waiting} waiting`,
      )}
      {card(
        'Schema',
        migrations
          ? migrations.pending.length
            ? `${migrations.pending.length} pending`
            : 'Current'
          : 'Unknown',
        'ops-migrations',
        migrations
          ? `${migrations.applied} of ${migrations.known} migrations applied`
          : 'error' in s.migrations
            ? s.migrations.error
            : null,
      )}
      {card(
        'Queues (Redis)',
        s.redis.ok ? `${s.redis.latencyMs} ms` : 'Unreachable',
        'ops-redis',
        `prefix ${s.redis.keyPrefix}${s.inlineJobs ? ' · inline jobs' : ''}`,
      )}
      {card('Storage', s.storage.writable ? 'Writable' : 'Read-only', 'ops-storage', s.storage.dir)}
    </div>
  );
}

function JobsPanel() {
  const jobs = useJobs();
  const run = useRunJob();
  if (jobs.isError) return <ErrorState description={describeError(jobs.error)} />;
  if (!jobs.data) return <TableSkeleton rows={8} />;
  return (
    <Card>
      <CardContent className="p-0">
        <Table data-testid="ops-jobs">
          <TableHeader>
            <TableRow>
              <TableHead>Job</TableHead>
              <TableHead>Queue</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead>Outcome</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.data.map((j) => (
              <TableRow key={j.name} data-testid="ops-job" data-name={j.name}>
                <TableCell>
                  <div className="font-mono text-xs font-medium">{j.name}</div>
                  <div className="text-xs text-muted-foreground">{j.description}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">{j.queue}</TableCell>
                <TableCell className="text-xs">
                  {humanSchedule(j.schedule) ?? (
                    <span className="text-muted-foreground">manual only</span>
                  )}
                  {j.schedule && !j.enabled ? (
                    <Badge variant="outline" className="ml-2">
                      disabled
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs">
                  {j.lastRun ? (
                    <>
                      <div>{when(j.lastRun.startedAt)}</div>
                      <div className="text-muted-foreground">
                        {j.lastRun.trigger.toLowerCase()} · {duration(j.lastRun.durationMs)}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </TableCell>
                <TableCell>
                  {j.lastRun ? (
                    <div className="flex items-center gap-2">
                      <StatusBadge tone={RUN_TONE[j.lastRun.status]}>
                        {j.lastRun.status}
                      </StatusBadge>
                      {j.failingStreak > 1 ? (
                        <Badge variant="destructive" data-testid="ops-streak">
                          {j.failingStreak} in a row
                        </Badge>
                      ) : null}
                    </div>
                  ) : null}
                  {j.lastRun?.error ? (
                    <div
                      className="mt-1 max-w-md truncate text-xs text-muted-foreground"
                      title={j.lastRun.error}
                    >
                      {j.lastRun.error}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  <Can permissions={[P['operations.manage']]}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={run.isPending}
                      data-testid="ops-run"
                      onClick={() =>
                        run.mutate(j.name, {
                          onSuccess: (r) =>
                            toast.success(`${j.name}: ${r.status} in ${duration(r.durationMs)}`),
                          onError: (e) => toast.error(describeError(e)),
                        })
                      }
                    >
                      <Play /> Run now
                    </Button>
                  </Can>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RunsPanel() {
  const [jobName, setJobName] = React.useState('ALL');
  const [status, setStatus] = React.useState('ALL');
  const jobs = useJobs();
  const runs = useJobRuns({
    pageSize: 50,
    jobName: jobName === 'ALL' ? undefined : jobName,
    status: status === 'ALL' ? undefined : (status as JobRunView['status']),
  });
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="mr-auto">Run history</CardTitle>
        <Select value={jobName} onValueChange={setJobName}>
          <SelectTrigger className="w-56" data-testid="ops-runs-job">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All jobs</SelectItem>
            {(jobs.data ?? []).map((j) => (
              <SelectItem key={j.name} value={j.name}>
                {j.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44" data-testid="ops-runs-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All outcomes</SelectItem>
            {(Object.keys(RUN_TONE) as JobRunView['status'][]).map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="p-0">
        {runs.isError ? (
          <ErrorState description={describeError(runs.error)} />
        ) : !runs.data ? (
          <TableSkeleton rows={8} />
        ) : runs.data.items.length === 0 ? (
          <EmptyState
            className="border-0"
            title="No runs yet"
            description="Runs appear once a schedule fires or a job is run manually."
          />
        ) : (
          <Table data-testid="ops-runs">
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Job</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Instance</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.items.map((r) => (
                <TableRow key={r.id} data-testid="ops-run-row">
                  <TableCell className="whitespace-nowrap text-xs">{when(r.startedAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.jobName}</TableCell>
                  <TableCell className="text-xs">{r.trigger.toLowerCase()}</TableCell>
                  <TableCell className="font-mono text-xs">{r.instanceId}</TableCell>
                  <TableCell className="text-xs">{duration(r.durationMs)}</TableCell>
                  <TableCell>
                    <StatusBadge tone={RUN_TONE[r.status]}>{r.status}</StatusBadge>
                    {r.error ? (
                      <div
                        className="mt-1 max-w-md truncate text-xs text-muted-foreground"
                        title={r.error}
                      >
                        {r.error}
                      </div>
                    ) : r.result ? (
                      <div className="mt-1 max-w-md truncate font-mono text-xs text-muted-foreground">
                        {JSON.stringify(r.result)}
                      </div>
                    ) : null}
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

function QueuesPanel() {
  const stats = useQueueStats();
  const [selected, setSelected] = React.useState<string | null>(null);
  const failed = useFailedJobs(selected);
  const retry = useRetryFailed();
  const discard = useDiscardFailed();
  if (stats.isError) return <ErrorState description={describeError(stats.error)} />;
  if (!stats.data) return <TableSkeleton rows={6} />;
  if (!stats.data.queues)
    return (
      <EmptyState
        title="Queues unavailable"
        description={`Redis is unreachable; scheduled work is paused until it returns (key prefix ${stats.data.keyPrefix}).`}
      />
    );
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Card>
        <CardContent className="p-0">
          <Table data-testid="ops-queues">
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Delayed</TableHead>
                <TableHead className="text-right">Failed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.data.queues.map((q) => (
                <TableRow
                  key={q.name}
                  className="cursor-pointer"
                  data-testid="ops-queue"
                  data-name={q.name}
                  data-state={selected === q.name ? 'selected' : undefined}
                  onClick={() => setSelected(q.name)}
                >
                  <TableCell className="font-mono text-xs">
                    {q.name}
                    {q.paused ? (
                      <Badge variant="outline" className="ml-2">
                        paused
                      </Badge>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      {q.schedulers.length} scheduler{q.schedulers.length === 1 ? '' : 's'}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular">{q.waiting}</TableCell>
                  <TableCell className="text-right tabular">{q.active}</TableCell>
                  <TableCell className="text-right tabular">{q.delayed}</TableCell>
                  <TableCell className="text-right tabular">
                    {q.failed > 0 ? <Badge variant="destructive">{q.failed}</Badge> : q.failed}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center gap-3">
          <CardTitle className="mr-auto">
            {selected ? `Dead letter · ${selected}` : 'Dead letter'}
          </CardTitle>
          {selected && failed.data?.length ? (
            <Can permissions={[P['operations.manage']]}>
              <Button
                size="sm"
                variant="outline"
                data-testid="ops-retry-all"
                disabled={retry.isPending}
                onClick={() =>
                  retry.mutate(
                    { queue: selected },
                    {
                      onSuccess: (r) =>
                        toast.success(`Re-queued ${r.retried} job${r.retried === 1 ? '' : 's'}`),
                      onError: (e) => toast.error(describeError(e)),
                    },
                  )
                }
              >
                <RotateCcw /> Retry all
              </Button>
            </Can>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          {!selected ? (
            <EmptyState
              className="border-0"
              title="Select a queue"
              description="Failed jobs of the selected queue appear here with their reason."
            />
          ) : failed.isLoading || !failed.data ? (
            <TableSkeleton rows={4} />
          ) : failed.data.length === 0 ? (
            <EmptyState
              className="border-0"
              title="No failed jobs"
              description="Every job on this queue completed or is still scheduled."
            />
          ) : (
            <Table data-testid="ops-failed">
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {failed.data.map((f) => (
                  <TableRow key={f.id} data-testid="ops-failed-row">
                    <TableCell>
                      <div className="font-mono text-xs">{f.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {f.attemptsMade} attempt{f.attemptsMade === 1 ? '' : 's'}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {when(f.finishedOn ?? f.timestamp)}
                    </TableCell>
                    <TableCell className="max-w-sm text-xs" title={f.stacktrace.join('\n')}>
                      <div className="truncate">{f.failedReason ?? '-'}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Can permissions={[P['operations.manage']]}>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Retry"
                          onClick={() =>
                            retry.mutate(
                              { queue: selected, id: f.id },
                              { onError: (e) => toast.error(describeError(e)) },
                            )
                          }
                        >
                          <RotateCcw />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Discard"
                          onClick={() =>
                            discard.mutate(
                              { queue: selected, id: f.id },
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
      </Card>
    </div>
  );
}

function IntegrityPanel() {
  const { me, activeCompany } = useSession();
  const [companyId, setCompanyId] = React.useState('ALL');
  const runs = useIntegrityRuns({
    pageSize: 50,
    companyId: companyId === 'ALL' ? undefined : companyId,
  });
  const runNow = useRunIntegrityCheck();
  const target = companyId === 'ALL' ? activeCompany?.id : companyId;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="mr-auto">Integrity runs</CardTitle>
        <Select value={companyId} onValueChange={setCompanyId}>
          <SelectTrigger className="w-56" data-testid="ops-integrity-company">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All companies</SelectItem>
            {(me?.companies ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.code} {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Can permissions={[P['operations.manage']]}>
          <Button
            size="sm"
            disabled={!target || runNow.isPending}
            data-testid="ops-integrity-run"
            onClick={() =>
              target &&
              runNow.mutate(target, {
                onSuccess: (r) =>
                  toast.success(`Integrity check ${r.status} for ${r.companyCode ?? 'company'}`),
                onError: (e) => toast.error(describeError(e)),
              })
            }
          >
            <ShieldCheck /> Run now
          </Button>
        </Can>
      </CardHeader>
      <CardContent className="p-0">
        {runs.isError ? (
          <ErrorState description={describeError(runs.error)} />
        ) : !runs.data ? (
          <TableSkeleton rows={6} />
        ) : runs.data.items.length === 0 ? (
          <EmptyState
            className="border-0"
            title="No integrity runs yet"
            description="The nightly job stores one row per company; run one now to see the outcome here."
          />
        ) : (
          <Table data-testid="ops-integrity">
            <TableHeader>
              <TableRow>
                <TableHead>Ran</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>As of</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Findings</TableHead>
                <TableHead>Notified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.items.map((r) => (
                <TableRow key={r.id} data-testid="ops-integrity-row">
                  <TableCell className="whitespace-nowrap text-xs">{when(r.ranAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.companyCode}</TableCell>
                  <TableCell className="text-xs">{r.asOf}</TableCell>
                  <TableCell>
                    <StatusBadge tone={INTEGRITY_TONE[r.status]}>{r.status}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.status === 'FAILED' ? (
                      <span className="text-muted-foreground">{r.error}</span>
                    ) : r.findings.length === 0 ? (
                      <span className="text-muted-foreground">all checks passed</span>
                    ) : (
                      r.findings.map((f) => (
                        <Badge
                          key={f.name}
                          variant={f.severity === 'CRITICAL' ? 'destructive' : 'outline'}
                          className="mr-1"
                        >
                          {f.name} · {f.count}
                        </Badge>
                      ))
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.notified ? 'yes' : r.status === 'OK' ? '-' : 'no'}
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
