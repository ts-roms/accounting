'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowDownToLine, ArrowUpFromLine, Plug, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { P, type SyncEntity } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  StatusBadge,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { usePushRecord, useRecordLinks } from '@/lib/api/integrations-hooks';
import type { RecordReferenceView } from '@/lib/api/integrations-types';
import { useSession } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { toneOf } from '@/components/status';

const ENTITY_LABEL: Partial<Record<SyncEntity, string>> = {
  invoices: 'invoice',
  bills: 'bill',
  customers: 'customer',
  vendors: 'vendor',
  products: 'product',
  'bank-transactions': 'statement',
};

/**
 * Where a record stands with every connected provider: imported from,
 * pushed to (with the provider's acknowledgement), and who could still
 * receive it. Renders nothing when no integration is involved, so ordinary
 * screens stay uncluttered. "Push again" is the targeted re-push that
 * integration managers use after fixing a rejected submission.
 */
export function RecordLinksPanel({
  entityType,
  internalId,
  /** Hide the "not yet sent" targets, e.g. for drafts that cannot be pushed anyway. */
  showTargets = true,
}: {
  entityType: SyncEntity;
  internalId: string;
  showTargets?: boolean;
}) {
  const { hasPermission } = useSession();
  const links = useRecordLinks(entityType, internalId);
  const push = usePushRecord();
  const canManage = hasPermission(P['integration.manage']);
  const label = ENTITY_LABEL[entityType] ?? 'record';
  if (links.isLoading) return <Skeleton className="h-16" data-testid="record-links-loading" />;
  if (links.isError || !links.data) return null;
  const targets = showTargets ? links.data.pushTargets : [];
  if (!links.data.references.length && !targets.length) return null;

  const send = (integrationId: string, name: string) =>
    push.mutate(
      { id: integrationId, entity: entityType, internalId },
      {
        onSuccess: (r) =>
          r.outcome === 'FAILED'
            ? toast.error(`${name} rejected the ${label}: ${r.error?.message ?? 'unknown error'}`)
            : toast.success(
                `${label[0]!.toUpperCase()}${label.slice(1)} sent to ${name}${r.externalId ? ` (${r.externalId})` : ''}`,
              ),
        onError: (e) => toast.error(describeError(e)),
      },
    );

  return (
    <Card data-testid="record-links-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Plug className="h-4 w-4" /> Integrations
        </CardTitle>
        <CardDescription>
          Where this {label} came from and which providers have received it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {links.data.references.length ? (
          <ul className="divide-y rounded-md border">
            {links.data.references.map((r) => (
              <ReferenceRow
                key={r.id}
                reference={r}
                canPush={canManage && r.canPush}
                pending={push.isPending}
                onPush={() => send(r.integrationId, r.integrationName)}
              />
            ))}
          </ul>
        ) : null}
        {targets.length ? (
          <ul className="space-y-2" data-testid="record-links-targets">
            {targets.map((t) => (
              <li
                key={t.integrationId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-sm"
              >
                <span className="text-muted-foreground">
                  Not yet sent to{' '}
                  <Link
                    href={`/admin/integrations/${t.integrationId}`}
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {t.integrationName}
                  </Link>{' '}
                  <span className="text-xs">({t.providerName})</span>
                </span>
                {canManage ? (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={push.isPending}
                    onClick={() => send(t.integrationId, t.integrationName)}
                    data-testid="record-links-push"
                  >
                    <ArrowUpFromLine /> Send now
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReferenceRow({
  reference: r,
  canPush,
  pending,
  onPush,
}: {
  reference: RecordReferenceView;
  canPush: boolean;
  pending: boolean;
  onPush: () => void;
}) {
  const outbound = r.direction === 'OUTBOUND';
  const when = typeof r.metadata.pushedAt === 'string' ? r.metadata.pushedAt : r.lastSeenAt;
  const Icon = outbound ? ArrowUpFromLine : ArrowDownToLine;
  return (
    <li
      className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
      data-testid="record-links-row"
      data-direction={r.direction}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/admin/integrations/${r.integrationId}`}
            className="truncate font-medium underline-offset-2 hover:underline"
          >
            {r.integrationName}
          </Link>
          <span className="text-xs text-muted-foreground">{r.providerName}</span>
          <StatusBadge tone={toneOf(outbound ? 'default' : 'secondary')}>
            {outbound ? 'Sent' : 'Imported'}
          </StatusBadge>
          {r.integrationStatus !== 'CONNECTED' && r.integrationStatus !== 'SYNCING' ? (
            <StatusBadge tone={toneOf('warning')}>{r.integrationStatus.toLowerCase()}</StatusBadge>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          <span className="font-mono" data-testid="record-links-external-id">
            {r.externalId}
          </span>
          {' · '}
          {outbound ? 'sent' : 'seen'} {formatDateTime(when)}
          {typeof r.metadata.pushedBy === 'string' ? ` by ${r.metadata.pushedBy}` : ''}
          {typeof r.metadata.jobId === 'string' ? (
            <>
              {' · '}
              <Link
                href={`/admin/integrations/${r.integrationId}?tab=sync`}
                className="underline-offset-2 hover:underline"
              >
                job
              </Link>
            </>
          ) : null}
        </div>
      </div>
      {canPush ? (
        <Button
          size="sm"
          variant="ghost"
          loading={pending}
          onClick={onPush}
          aria-label={`Push again to ${r.integrationName}`}
          data-testid="record-links-repush"
        >
          <RefreshCw /> Push again
        </Button>
      ) : null}
    </li>
  );
}
