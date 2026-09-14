'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Plug, RefreshCw, Trash2, Unplug, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
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
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCancelSync,
  useDeleteIntegration,
  useExternalReferences,
  useInboundEvents,
  useIntegration,
  useIntegrationAction,
  useIntegrationHealth,
  useIntegrationLogs,
  useIntegrationMappings,
  useOAuthStart,
  usePreviewMapping,
  useSyncJobs,
  useTriggerSync,
  useUpdateIntegration,
  useUpsertMapping,
  useWebhooks,
} from '@/lib/api/integrations-hooks';
import type { IntegrationView } from '@/lib/api/integrations-types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { Can, ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { Stat } from '@/components/fixed-assets/shared';
import {
  DeliveryStatusBadge,
  HealthBadge,
  IntegrationStatusBadge,
  JobStatusBadge,
  KeyValue,
} from './shared';
import { useWebhookDeliveries } from '@/lib/api/integrations-hooks';

/** Enterprise-style detail: one tab per concern instead of one overwhelming page. */
export function IntegrationDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const detail = useIntegration(id);
  const action = useIntegrationAction();
  const sync = useTriggerSync();
  const remove = useDeleteIntegration();
  const oauth = useOAuthStart();
  const [deleting, setDeleting] = React.useState(false);
  React.useEffect(() => {
    const result = params.get('oauth');
    if (result === 'success') toast.success('Authorisation completed');
    if (result === 'error')
      toast.error(`Authorisation failed: ${params.get('reason') ?? 'unknown'}`);
  }, [params]);
  const i = detail.data;
  if (!i) return <Skeleton className="h-40" />;
  const run = (
    a: 'connect' | 'disconnect' | 'test' | 'oauth/refresh' | 'oauth/disconnect',
    label: string,
  ) =>
    action.mutate(
      { id, action: a },
      {
        onSuccess: (r) => {
          if ('ok' in r) toast[r.ok ? 'success' : 'error'](`${r.message} (${r.latencyMs} ms)`);
          else toast.success(label);
        },
        onError: (e) => toast.error(describeError(e)),
      },
    );
  const isOAuth = i.authType === 'OAUTH2' || i.authType === 'OIDC';
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="icon" asChild>
              <Link href="/admin/integrations" aria-label="Back">
                <ArrowLeft />
              </Link>
            </Button>
            {i.name}
            <IntegrationStatusBadge status={i.status} />
            <HealthBadge status={i.healthStatus} score={i.healthScore} />
            {i.demo ? <Badge variant="outline">demo</Badge> : null}
          </span>
        }
        description={`${i.providerName} · ${titleCase(i.category)} · ${i.authType}`}
        actions={
          <Can permissions={[P['integration.manage']]}>
            {isOAuth && i.status !== 'CONNECTED' ? (
              <Button
                size="sm"
                onClick={() =>
                  oauth.mutate(
                    { id, returnTo: `/admin/integrations/${id}` },
                    {
                      onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
                      onError: (e) => toast.error(describeError(e)),
                    },
                  )
                }
              >
                <Plug /> Authorise
              </Button>
            ) : null}
            {!isOAuth && (i.status === 'DISCONNECTED' || i.status === 'ERROR') ? (
              <Button size="sm" onClick={() => run('connect', 'Connected')}>
                <Plug /> Connect
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => run('test', 'Tested')}
              data-testid="integration-test"
            >
              <Zap /> Test connection
            </Button>
            {i.capabilities.includes('PULL') &&
            (i.status === 'CONNECTED' || i.status === 'SYNCING') ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  sync.mutate(
                    { id },
                    {
                      onSuccess: () => toast.success('Sync queued'),
                      onError: (e) => toast.error(describeError(e)),
                    },
                  )
                }
                data-testid="integration-sync"
              >
                <RefreshCw /> Sync now
              </Button>
            ) : null}
            {i.status !== 'DISCONNECTED' && i.status !== 'DISABLED' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => run(isOAuth ? 'oauth/disconnect' : 'disconnect', 'Disconnected')}
              >
                <Unplug /> Disconnect
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
              <Trash2 />
            </Button>
          </Can>
        }
      />
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Last sync" value={formatDateTime(i.lastSyncAt)} />
        <Stat
          label="Next sync"
          value={i.syncSchedule ? formatDateTime(i.nextSyncAt) : 'Manual'}
          hint={i.syncSchedule ?? undefined}
        />
        <Stat
          label="Consecutive failures"
          value={i.failureCount}
          danger={i.failureCount > 0}
          hint={i.lastFailureAt ? `last ${formatDateTime(i.lastFailureAt)}` : undefined}
        />
        <Stat label="Last success" value={formatDateTime(i.lastSuccessAt)} />
      </div>
      {i.lastError ? (
        <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          {i.lastError}
        </p>
      ) : null}
      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          {['overview', 'authentication', 'sync', 'webhooks', 'mappings', 'logs', 'health'].map(
            (t) => (
              <TabsTrigger key={t} value={t}>
                {titleCase(t)}
              </TabsTrigger>
            ),
          )}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab i={i} />
        </TabsContent>
        <TabsContent value="authentication">
          <AuthenticationTab i={i} onRefresh={() => run('oauth/refresh', 'Token refreshed')} />
        </TabsContent>
        <TabsContent value="sync">
          <SyncTab i={i} />
        </TabsContent>
        <TabsContent value="webhooks">
          <WebhooksTab i={i} />
        </TabsContent>
        <TabsContent value="mappings">
          <MappingsTab i={i} />
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab i={i} />
        </TabsContent>
        <TabsContent value="health">
          <HealthTab i={i} />
        </TabsContent>
      </Tabs>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${i.name}?`}
        description="Credentials are wiped immediately; the integration and its audit trail are kept as deleted."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(id, {
            onSuccess: () => {
              toast.success('Integration deleted');
              router.push('/admin/integrations');
            },
            onError: (e) => toast.error(describeError(e)),
          })
        }
      />
    </>
  );
}

function OverviewTab({ i }: { i: IntegrationView }) {
  const update = useUpdateIntegration();
  const { hasPermission } = useSession();
  const [schedule, setSchedule] = React.useState(i.syncSchedule ?? '');
  const [config, setConfig] = React.useState(JSON.stringify(i.config, null, 2));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardContent className="p-4">
          <KeyValue
            items={[
              ['Provider', `${i.providerName} (${i.provider})`],
              ['Category', titleCase(i.category)],
              [
                'Capabilities',
                <span key="c" className="flex flex-wrap gap-1">
                  {i.capabilities.map((c) => (
                    <Badge key={c} variant="secondary">
                      {titleCase(c)}
                    </Badge>
                  ))}
                </span>,
              ],
              [
                'Scopes',
                <span key="s" className="font-mono text-xs">
                  {i.scopes.join(', ') || 'none'}
                </span>,
              ],
              ['Connected', formatDateTime(i.connectedAt)],
              ['Created', formatDateTime(i.createdAt)],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="space-y-1">
            <Label>Sync schedule (cron)</Label>
            <Input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="e.g. 0 * * * *"
              disabled={!hasPermission(P['integration.manage'])}
            />
          </div>
          <div className="space-y-1">
            <Label>Configuration</Label>
            <Textarea
              rows={8}
              className="font-mono text-xs"
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              disabled={!hasPermission(P['integration.manage'])}
            />
          </div>
          <Can permissions={[P['integration.manage']]}>
            <Button
              size="sm"
              loading={update.isPending}
              onClick={() => {
                let parsed: Record<string, unknown>;
                try {
                  parsed = JSON.parse(config) as Record<string, unknown>;
                } catch {
                  toast.error('Configuration must be valid JSON');
                  return;
                }
                update.mutate(
                  { id: i.id, config: parsed, syncSchedule: schedule || null },
                  {
                    onSuccess: () => toast.success('Configuration saved'),
                    onError: (e) => toast.error(describeError(e)),
                  },
                );
              }}
            >
              Save configuration
            </Button>
          </Can>
        </CardContent>
      </Card>
    </div>
  );
}

function AuthenticationTab({ i, onRefresh }: { i: IntegrationView; onRefresh: () => void }) {
  const update = useUpdateIntegration();
  const [secret, setSecret] = React.useState<{ key: string; value: string }>({
    key: 'apiKey',
    value: '',
  });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardContent className="p-4">
          <KeyValue
            items={[
              ['Method', i.authType],
              [
                'Stored credentials',
                i.credentials.length
                  ? i.credentials
                      .map(
                        (c) =>
                          `${c.kind}${c.expiresAt ? ` (expires ${formatDateTime(c.expiresAt)})` : ''}`,
                      )
                      .join(', ')
                  : 'none',
              ],
              ...(i.oauth
                ? [
                    [
                      'OAuth',
                      `${i.oauth.status}${i.oauth.accessExpiresAt ? ` · access expires ${formatDateTime(i.oauth.accessExpiresAt)}` : ''}`,
                    ] as [string, React.ReactNode],
                  ]
                : []),
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Secrets are encrypted at rest (AES-256-GCM) and never returned by the API, shown in logs
            or written to the audit trail.
          </p>
          {i.oauth?.status === 'CONNECTED' ? (
            <Can permissions={[P['integration.manage']]}>
              <Button size="sm" variant="outline" className="mt-3" onClick={onRefresh}>
                Refresh access token
              </Button>
            </Can>
          ) : null}
        </CardContent>
      </Card>
      <Can permissions={[P['integration.manage']]}>
        <Card>
          <CardContent className="space-y-3 p-4">
            <Label>Rotate a credential</Label>
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <Select value={secret.key} onValueChange={(key) => setSecret({ ...secret, key })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    'apiKey',
                    'bearerToken',
                    'username',
                    'password',
                    'hmacSecret',
                    'webhookSecret',
                  ].map((k) => (
                    <SelectItem key={k} value={k}>
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="password"
                autoComplete="off"
                value={secret.value}
                onChange={(e) => setSecret({ ...secret, value: e.target.value })}
                placeholder="New value"
              />
            </div>
            <Button
              size="sm"
              loading={update.isPending}
              disabled={!secret.value}
              onClick={() =>
                update.mutate(
                  { id: i.id, credentials: { [secret.key]: secret.value } as never },
                  {
                    onSuccess: () => {
                      toast.success('Credential rotated');
                      setSecret({ ...secret, value: '' });
                    },
                    onError: (e) => toast.error(describeError(e)),
                  },
                )
              }
            >
              Rotate
            </Button>
          </CardContent>
        </Card>
      </Can>
    </div>
  );
}

function SyncTab({ i }: { i: IntegrationView }) {
  const jobs = useSyncJobs(i.id, { pageSize: 25 });
  const cursors = useExternalReferences(i.id);
  const trigger = useTriggerSync();
  const cancel = useCancelSync();
  const [entity, setEntity] = React.useState<string>('ALL');
  const [mode, setMode] = React.useState<'INCREMENTAL' | 'FULL'>('INCREMENTAL');
  return (
    <div className="space-y-3">
      <Can permissions={[P['integration.manage']]}>
        <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
          <div className="space-y-1">
            <Label>Entity</Label>
            <Select value={entity} onValueChange={setEntity}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All entities</SelectItem>
                {[
                  'customers',
                  'vendors',
                  'invoices',
                  'bills',
                  'payments',
                  'bank-transactions',
                  'products',
                ].map((e) => (
                  <SelectItem key={e} value={e}>
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'INCREMENTAL' | 'FULL')}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INCREMENTAL">Incremental</SelectItem>
                <SelectItem value="FULL">Full</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            loading={trigger.isPending}
            onClick={() =>
              trigger.mutate(
                { id: i.id, mode, entity: entity === 'ALL' ? undefined : (entity as never) },
                {
                  onSuccess: () => toast.success('Sync queued'),
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <RefreshCw /> Run sync
          </Button>
        </div>
      </Can>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Processed</TableHead>
            <TableHead className="text-right">Created</TableHead>
            <TableHead className="text-right">Updated</TableHead>
            <TableHead className="text-right">Skipped</TableHead>
            <TableHead className="text-right">Failed</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead>Cursor</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {(jobs.data?.items ?? []).map((j) => (
            <React.Fragment key={j.id}>
              <TableRow data-testid="sync-job">
                <TableCell className="text-xs">
                  {formatDateTime(j.startedAt ?? j.createdAt)}
                </TableCell>
                <TableCell>{j.entity ?? 'all'}</TableCell>
                <TableCell>{titleCase(j.mode)}</TableCell>
                <TableCell>{titleCase(j.trigger)}</TableCell>
                <TableCell>
                  <JobStatusBadge status={j.status} />
                </TableCell>
                <TableCell className="text-right font-mono">{j.recordsProcessed}</TableCell>
                <TableCell className="text-right font-mono">{j.recordsCreated}</TableCell>
                <TableCell className="text-right font-mono">{j.recordsUpdated}</TableCell>
                <TableCell className="text-right font-mono">{j.recordsSkipped}</TableCell>
                <TableCell
                  className={`text-right font-mono ${j.recordsFailed ? 'text-destructive' : ''}`}
                >
                  {j.recordsFailed}
                </TableCell>
                <TableCell className="text-right font-mono text-xs">
                  {j.durationMs !== null ? `${j.durationMs} ms` : '-'}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {j.lastCursor ?? '-'}
                </TableCell>
                <TableCell>
                  <Can permissions={[P['integration.manage']]}>
                    {j.status === 'QUEUED' || j.status === 'RUNNING' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancel.mutate({ id: i.id, jobId: j.id })}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    {j.status === 'FAILED' || j.status === 'PAUSED' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          trigger.mutate(
                            { id: i.id, resumeJobId: j.id, mode: j.mode },
                            {
                              onSuccess: () => toast.success('Resume queued'),
                              onError: (e) => toast.error(describeError(e)),
                            },
                          )
                        }
                      >
                        Resume
                      </Button>
                    ) : null}
                  </Can>
                </TableCell>
              </TableRow>
              {j.errorMessage || j.failures.length ? (
                <TableRow>
                  <TableCell colSpan={13} className="bg-muted/30 text-xs">
                    {j.errorMessage ? (
                      <div className="text-destructive">
                        {j.errorCode}: {j.errorMessage}
                      </div>
                    ) : null}
                    {j.failures.slice(0, 5).map((f, idx) => (
                      <div key={idx} className="text-muted-foreground">
                        {f.externalId ?? '-'} · {f.code}: {f.message}
                      </div>
                    ))}
                    {j.failures.length > 5 ? (
                      <div className="text-muted-foreground">+{j.failures.length - 5} more</div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ) : null}
            </React.Fragment>
          ))}
          {jobs.data && jobs.data.items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={13} className="text-center text-sm text-muted-foreground">
                No sync jobs yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <div>
        <Label>External references ({cursors.data?.length ?? 0})</Label>
        <div className="mt-1 max-h-48 overflow-auto rounded-md border text-xs">
          {(cursors.data ?? []).slice(0, 100).map((r) => (
            <div key={r.id} className="flex justify-between gap-2 border-b px-3 py-1 last:border-0">
              <span>
                {r.entityType} · <span className="font-mono">{r.externalId}</span>
              </span>
              <span className="font-mono text-muted-foreground">
                {r.internalId.slice(0, 8)}… · {formatDateTime(r.lastSeenAt)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WebhooksTab({ i }: { i: IntegrationView }) {
  const events = useInboundEvents(i.id);
  const subs = useWebhooks();
  const deliveries = useWebhookDeliveries({ pageSize: 20 });
  const mine = (subs.data ?? []).filter((w) => w.integrationId === i.id);
  const inboundUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/v1/webhooks/inbound/${i.id}`
      : `/api/v1/webhooks/inbound/${i.id}`;
  return (
    <div className="space-y-4">
      {i.capabilities.includes('WEBHOOKS') ? (
        <Card>
          <CardContent className="p-4">
            <Label>Inbound endpoint (register this with the provider)</Label>
            <code
              className="mt-1 block break-all rounded bg-muted/40 p-2 font-mono text-xs"
              data-testid="inbound-url"
            >
              {inboundUrl}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              Requests are authenticated by the provider signature over the raw body; events are
              deduplicated by their id so replays are harmless.
            </p>
          </CardContent>
        </Card>
      ) : null}
      <div>
        <Label>Received events</Label>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>External id</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(events.data ?? []).map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs">{formatDateTime(e.occurredAt)}</TableCell>
                <TableCell className="font-mono text-xs">{e.eventType}</TableCell>
                <TableCell className="font-mono text-xs">{e.externalEventId}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      e.status === 'PROCESSED'
                        ? 'success'
                        : e.status === 'FAILED'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {titleCase(e.status)}
                  </Badge>
                </TableCell>
                <TableCell>{e.attempts}</TableCell>
                <TableCell className="max-w-80 truncate text-xs text-destructive">
                  {e.lastError}
                </TableCell>
              </TableRow>
            ))}
            {events.data && events.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  No inbound events.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>
      <div>
        <Label>Outbound subscriptions linked to this integration</Label>
        {mine.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None.{' '}
            <Link href="/admin/webhooks" className="underline">
              Manage webhooks
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-1 divide-y rounded-md border text-sm">
            {mine.map((w) => (
              <li key={w.id} className="flex justify-between px-3 py-1.5">
                <span>
                  {w.name} · <span className="font-mono text-xs">{w.url}</span>
                </span>
                <Badge variant={w.status === 'ACTIVE' ? 'success' : 'outline'}>{w.status}</Badge>
              </li>
            ))}
          </ul>
        )}
        {mine.length ? (
          <div className="mt-2 text-xs text-muted-foreground">
            Recent deliveries:{' '}
            {(deliveries.data?.items ?? [])
              .filter((d) => mine.some((w) => w.id === d.webhookId))
              .slice(0, 5)
              .map((d) => (
                <span key={d.id} className="mr-2 inline-flex items-center gap-1">
                  {d.eventType} <DeliveryStatusBadge status={d.status} />
                </span>
              ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MappingsTab({ i }: { i: IntegrationView }) {
  const mappings = useIntegrationMappings(i.id);
  const upsert = useUpsertMapping();
  const preview = usePreviewMapping();
  const [entity, setEntity] = React.useState('customers');
  const [rules, setRules] = React.useState('');
  const [lookups, setLookups] = React.useState('{}');
  const [sample, setSample] = React.useState('{\n  "id": "123",\n  "name": "Sample Co"\n}');
  React.useEffect(() => {
    const stored = mappings.data?.mappings.find(
      (m) => m.entity === entity && m.direction === 'INBOUND',
    );
    const source = stored?.rules ?? mappings.data?.defaults[entity] ?? [];
    setRules(JSON.stringify(source, null, 2));
    setLookups(JSON.stringify(stored?.lookups ?? {}, null, 2));
  }, [mappings.data, entity]);
  const stored = mappings.data?.mappings.find(
    (m) => m.entity === entity && m.direction === 'INBOUND',
  );
  const parse = () => {
    try {
      return { rules: JSON.parse(rules), lookups: JSON.parse(lookups || '{}') };
    } catch {
      toast.error('Rules and lookups must be valid JSON');
      return null;
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Select value={entity} onValueChange={setEntity}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                'customers',
                'vendors',
                'invoices',
                'bills',
                'payments',
                'bank-transactions',
                'products',
              ].map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant={stored ? 'default' : 'outline'}>
            {stored
              ? `custom v${stored.version}`
              : mappings.data?.defaults[entity]
                ? 'connector default'
                : 'no mapping'}
          </Badge>
        </div>
        <Label>Field rules (target, source, transforms, when, required, default)</Label>
        <Textarea
          rows={16}
          className="font-mono text-xs"
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          data-testid="mapping-rules"
        />
        <Label>Lookup tables</Label>
        <Textarea
          rows={4}
          className="font-mono text-xs"
          value={lookups}
          onChange={(e) => setLookups(e.target.value)}
        />
        <Can permissions={[P['integration.manage']]}>
          <Button
            size="sm"
            loading={upsert.isPending}
            onClick={() => {
              const p = parse();
              if (!p) return;
              upsert.mutate(
                {
                  id: i.id,
                  entity: entity as never,
                  direction: 'INBOUND',
                  name: `${entity} mapping`,
                  rules: p.rules,
                  lookups: p.lookups,
                  isActive: true,
                },
                {
                  onSuccess: () => toast.success('Mapping saved'),
                  onError: (e) => toast.error(describeError(e)),
                },
              );
            }}
          >
            Save mapping
          </Button>
        </Can>
      </div>
      <div className="space-y-2">
        <Label>Preview with a sample record</Label>
        <Textarea
          rows={8}
          className="font-mono text-xs"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          loading={preview.isPending}
          onClick={() => {
            try {
              preview.mutate({
                id: i.id,
                entity: entity as never,
                direction: 'INBOUND',
                sample: JSON.parse(sample),
              });
            } catch {
              toast.error('Sample must be valid JSON');
            }
          }}
        >
          Preview
        </Button>
        {preview.data ? (
          <pre
            className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs"
            data-testid="mapping-preview"
          >
            {JSON.stringify(preview.data, null, 2)}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

function LogsTab({ i }: { i: IntegrationView }) {
  const [status, setStatus] = React.useState('ALL');
  const logs = useIntegrationLogs(i.id, {
    pageSize: 50,
    status: status === 'ALL' ? undefined : (status as never),
  });
  return (
    <div className="space-y-2">
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">All statuses</SelectItem>
          <SelectItem value="SUCCESS">Success</SelectItem>
          <SelectItem value="FAILURE">Failure</SelectItem>
          <SelectItem value="SKIPPED">Skipped</SelectItem>
        </SelectContent>
      </Select>
      <LogTable rows={logs.data?.items ?? []} />
    </div>
  );
}

export function LogTable({
  rows,
  showIntegration = false,
}: {
  rows: Array<{
    id: string;
    occurredAt: string;
    direction: string;
    operation: string;
    status: string;
    httpStatus: number | null;
    errorCode: string | null;
    durationMs: number | null;
    message: string | null;
    correlationId: string | null;
    integrationId?: string | null;
  }>;
  showIntegration?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          {showIntegration ? <TableHead>Integration</TableHead> : null}
          <TableHead>Dir</TableHead>
          <TableHead>Operation</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>HTTP</TableHead>
          <TableHead>Error</TableHead>
          <TableHead className="text-right">ms</TableHead>
          <TableHead>Message</TableHead>
          <TableHead>Correlation</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((l) => (
          <TableRow key={l.id} data-testid="integration-log">
            <TableCell className="whitespace-nowrap text-xs">
              {formatDateTime(l.occurredAt)}
            </TableCell>
            {showIntegration ? (
              <TableCell className="font-mono text-xs">
                {l.integrationId?.slice(0, 8) ?? '-'}
              </TableCell>
            ) : null}
            <TableCell>
              <Badge variant="outline">{l.direction === 'INBOUND' ? 'IN' : 'OUT'}</Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">{l.operation}</TableCell>
            <TableCell>
              <Badge
                variant={
                  l.status === 'SUCCESS'
                    ? 'success'
                    : l.status === 'FAILURE'
                      ? 'destructive'
                      : 'secondary'
                }
              >
                {l.status}
              </Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">{l.httpStatus ?? ''}</TableCell>
            <TableCell className="font-mono text-xs text-destructive">
              {l.errorCode ?? ''}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">{l.durationMs ?? ''}</TableCell>
            <TableCell className="max-w-96 truncate text-xs">{l.message}</TableCell>
            <TableCell className="font-mono text-[10px] text-muted-foreground">
              {l.correlationId?.slice(0, 12)}
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={showIntegration ? 10 : 9}
              className="text-center text-sm text-muted-foreground"
            >
              No log entries.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function HealthTab({ i }: { i: IntegrationView }) {
  const health = useIntegrationHealth(i.id);
  const h = health.data;
  if (!h) return <Skeleton className="h-32" />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div
              className={`text-4xl font-semibold ${h.score >= 80 ? 'text-success' : h.score >= 50 ? 'text-warning' : 'text-destructive'}`}
              data-testid="health-score"
            >
              {h.score}
            </div>
            <div>
              <HealthBadge status={h.status} />
              <div className="text-xs text-muted-foreground">
                checked {formatDateTime(h.checkedAt)}
              </div>
            </div>
          </div>
          <KeyValue
            items={[
              ['Connection', titleCase(h.connection)],
              ['Last successful sync', formatDateTime(h.lastSyncAt)],
              [
                'Last failure',
                h.lastFailureAt
                  ? `${formatDateTime(h.lastFailureAt)} - ${h.lastError ?? ''}`
                  : 'none',
              ],
              ['Failure count', h.failureCount],
              ['Webhook health', titleCase(h.webhookHealth)],
              ['API latency', h.apiLatencyMs !== null ? `${h.apiLatencyMs} ms avg (24h)` : 'n/a'],
              ['Rate limit', h.rateLimitState],
              [
                'Credential expiry',
                h.credentialExpiry.state === 'NONE'
                  ? 'not tracked'
                  : `${titleCase(h.credentialExpiry.state)}${h.credentialExpiry.daysLeft !== null ? ` (${h.credentialExpiry.daysLeft} days)` : ''}`,
              ],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <Label>Score deductions</Label>
          {h.deductions.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No issues detected.</p>
          ) : (
            <ul className="mt-1 divide-y text-sm">
              {h.deductions.map((d) => (
                <li key={d.code} className="flex justify-between py-1">
                  <span>{d.detail}</span>
                  <span className="font-mono text-destructive">-{d.points}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            The score is computed from measured conditions only: status, recent failures, credential
            expiry, webhook deliveries, latency, provider throttling and schedule adherence.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
