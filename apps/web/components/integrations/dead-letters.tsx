'use client';
import * as React from 'react';
import Link from 'next/link';
import { Archive, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useDeadLetterAction,
  useDeadLetters,
  useReplayAllDeadLetters,
  useRetentionPolicy,
} from '@/lib/api/integrations-hooks';
import type { DeadLetterKind, DeadLetterView } from '@/lib/api/integrations-types';
import { useSession } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { Can, EmptyState, ErrorState } from '@/components/ui-ext/page';
import { toneOf } from '@/components/status';

const KIND_LABEL: Record<DeadLetterKind, string> = {
  WEBHOOK_DELIVERY: 'Webhook delivery',
  INBOUND_EVENT: 'Inbound event',
  OUTBOX_EVENT: 'Outbox event',
  SYNC_JOB: 'Sync / push job',
};

function ownerHref(item: DeadLetterView): string | null {
  if (!item.ownerId) return null;
  return item.kind === 'WEBHOOK_DELIVERY'
    ? `/admin/webhooks?webhookId=${item.ownerId}`
    : `/admin/integrations/${item.ownerId}`;
}

/**
 * The dead-letter queue: everything the platform gave up on, in one place,
 * with replay (through each kind's own idempotent path) and discard
 * (acknowledged, kept as history until retention removes it). Below it the
 * retention policy the nightly cleanup applies, so nobody has to read the
 * env file to know how long evidence is kept.
 */
export function DeadLettersPanel() {
  const { hasPermission } = useSession();
  const queue = useDeadLetters();
  const policy = useRetentionPolicy();
  const act = useDeadLetterAction();
  const replayAll = useReplayAllDeadLetters();
  const canManage = hasPermission(P['integration.manage']);
  const [busy, setBusy] = React.useState<string | null>(null);
  if (queue.isLoading) return <Skeleton className="h-40" />;
  if (queue.isError || !queue.data)
    return <ErrorState description={describeError(queue.error)} onRetry={() => queue.refetch()} />;
  const { summary, items } = queue.data;
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  const run = async (action: 'replay' | 'discard', item: DeadLetterView) => {
    setBusy(`${action}:${item.id}`);
    try {
      const r = await act.mutateAsync({ action, kind: item.kind, id: item.id });
      toast.success(
        action === 'replay' ? `Replayed: ${r.result ?? 'queued'}` : `Discarded (${r.status})`,
      );
    } catch (err) {
      toast.error(describeError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4" data-testid="dead-letters">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Dead letters</CardTitle>
            <CardDescription>
              Exhausted deliveries, failed events and failed jobs nobody has resumed. Replay runs
              the original path again; discard acknowledges without processing.
            </CardDescription>
          </div>
          <Can permissions={[P['integration.manage']]}>
            <Button
              size="sm"
              variant="outline"
              disabled={total === 0}
              loading={replayAll.isPending}
              onClick={() =>
                replayAll.mutate(undefined, {
                  onSuccess: (counts) =>
                    toast.success(
                      `Replayed ${Object.values(counts).reduce((a, b) => a + b, 0)} dead letter(s)`,
                    ),
                  onError: (e) => toast.error(describeError(e)),
                })
              }
              data-testid="dead-letters-replay-all"
            >
              <RotateCcw /> Replay all
            </Button>
          </Can>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            {(Object.keys(KIND_LABEL) as DeadLetterKind[]).map((k) => (
              <div key={k} className="rounded-md border p-3" data-testid={`dead-letters-${k}`}>
                <div className="type-label text-muted-foreground">{KIND_LABEL[k]}</div>
                <div
                  className={`text-2xl font-semibold tabular ${summary[k] ? 'text-critical' : ''}`}
                >
                  {summary[k]}
                </div>
              </div>
            ))}
          </div>
          {items.length === 0 ? (
            <EmptyState
              title="Nothing is stuck"
              description="Every delivery, event and job either completed, is retrying, or was acknowledged."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const href = ownerHref(item);
                  return (
                    <TableRow key={`${item.kind}:${item.id}`} data-testid="dead-letter-row">
                      <TableCell className="text-xs">{formatDateTime(item.occurredAt)}</TableCell>
                      <TableCell>
                        <StatusBadge tone={toneOf('destructive')}>
                          {KIND_LABEL[item.kind]}
                        </StatusBadge>
                      </TableCell>
                      <TableCell>
                        {href ? (
                          <Link href={href} className="underline-offset-2 hover:underline">
                            {item.ownerName}
                          </Link>
                        ) : (
                          item.ownerName
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.subject}</TableCell>
                      <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                        {item.error ?? '-'}
                      </TableCell>
                      <TableCell className="text-right font-mono">{item.attempts}</TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {canManage ? (
                          <>
                            {item.replayable ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={busy === `replay:${item.id}`}
                                onClick={() => run('replay', item)}
                                data-testid="dead-letter-replay"
                              >
                                <RotateCcw /> Replay
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={busy === `discard:${item.id}`}
                              onClick={() => run('discard', item)}
                              data-testid="dead-letter-discard"
                            >
                              <Archive /> Discard
                            </Button>
                          </>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retention</CardTitle>
          <CardDescription>
            Applied nightly by the integration-cleanup job in bounded batches; dead letters are kept{' '}
            {policy.data?.deadLetterMultiplier ?? 2}x longer so they can still be replayed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {policy.data ? (
            <dl
              className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4"
              data-testid="retention-policy"
            >
              <dt className="text-muted-foreground">Integration logs</dt>
              <dd className="tabular">{policy.data.logDays} days</dd>
              <dt className="text-muted-foreground">Events (in / outbox)</dt>
              <dd className="tabular">{policy.data.eventDays} days</dd>
              <dt className="text-muted-foreground">Webhook deliveries</dt>
              <dd className="tabular">{policy.data.deliveryDays} days</dd>
              <dt className="text-muted-foreground">Sync / push jobs</dt>
              <dd className="tabular">{policy.data.syncJobDays} days</dd>
            </dl>
          ) : (
            <Skeleton className="h-10" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
