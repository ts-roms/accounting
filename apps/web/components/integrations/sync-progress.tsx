'use client';
import * as React from 'react';
import { Check, Loader2, Pause, X } from 'lucide-react';
import { AnimatedNumber, Card, CardContent, CardHeader, CardTitle, cn } from '@accounting/ui';
import type { SyncJobView } from '@/lib/api/integrations-types';
import { formatDateTime, titleCase } from '@/lib/format';

/**
 * Live sync panel: one row per entity for the latest job. Counters tween as
 * the job list refetches (every 2s while a job is active); a spinner marks
 * running jobs, a check completed ones. Sync jobs report processed counts
 * only (providers do not publish totals), so there is no fabricated
 * percentage - the row states the real numbers.
 */
export function SyncProgress({ jobs, className }: { jobs: SyncJobView[]; className?: string }) {
  const latest = React.useMemo(() => {
    const byEntity = new Map<string, SyncJobView>();
    for (const j of jobs) {
      const key = j.entity ?? 'all';
      const cur = byEntity.get(key);
      if (!cur || (j.startedAt ?? j.createdAt) > (cur.startedAt ?? cur.createdAt))
        byEntity.set(key, j);
    }
    return Array.from(byEntity.values());
  }, [jobs]);
  const active = latest.some((j) => j.status === 'RUNNING' || j.status === 'QUEUED');
  if (latest.length === 0) return null;

  return (
    <Card className={className} data-testid="sync-progress" aria-busy={active}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="inline-flex items-center gap-2">
          {active ? <Loader2 className="size-4 animate-spin text-primary" aria-hidden /> : null}
          {active ? 'Syncing…' : 'Latest sync by entity'}
        </CardTitle>
        <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {active
            ? 'Updating every few seconds'
            : `Last run ${formatDateTime(latest[0]!.finishedAt ?? latest[0]!.startedAt)}`}
        </span>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {latest.map((j) => {
            const running = j.status === 'RUNNING' || j.status === 'QUEUED';
            const failed = j.status === 'FAILED';
            const paused = j.status === 'PAUSED' || j.status === 'CANCELLED';
            return (
              <li
                key={j.id}
                className="grid grid-cols-[1fr_auto_auto] items-center gap-4 py-2 text-sm"
                data-state={j.status}
              >
                <span className="inline-flex items-center gap-2">
                  <span className="flex size-4 items-center justify-center">
                    {running ? (
                      <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
                    ) : failed ? (
                      <X className="size-3.5 text-critical" strokeWidth={3} aria-hidden />
                    ) : paused ? (
                      <Pause className="size-3.5 text-warning" aria-hidden />
                    ) : (
                      <Check
                        className="size-3.5 text-positive animate-enter-fast fade-in scale-in-80"
                        strokeWidth={3}
                        aria-hidden
                      />
                    )}
                  </span>
                  <span className="font-medium">{titleCase(j.entity ?? 'all')}</span>
                  <span className="text-xs text-muted-foreground">{titleCase(j.mode)}</span>
                </span>
                <span className="tabular text-right text-xs text-muted-foreground">
                  <AnimatedNumber
                    value={j.recordsProcessed}
                    animateOnMount={false}
                    className="text-sm font-medium text-foreground"
                    duration="slow"
                  />{' '}
                  processed
                  {j.recordsCreated ? <> · {j.recordsCreated} new</> : null}
                  {j.recordsUpdated ? <> · {j.recordsUpdated} updated</> : null}
                </span>
                <span
                  className={cn(
                    'tabular text-right text-xs',
                    j.recordsFailed ? 'text-critical' : 'text-muted-foreground',
                  )}
                >
                  {j.recordsFailed
                    ? `${j.recordsFailed} failed`
                    : running
                      ? 'running'
                      : titleCase(j.status)}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
