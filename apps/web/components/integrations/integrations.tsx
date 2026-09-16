'use client';
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { Cable, Plug, RefreshCw, Unplug, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { P, type IntegrationStatus } from '@accounting/types';
import {
  Badge,
  Button,
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
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateIntegration,
  useIntegrationAction,
  useIntegrations,
  useOAuthStart,
  useProviders,
  useTriggerSync,
} from '@/lib/api/integrations-hooks';
import type { IntegrationView, ProviderDescriptor } from '@/lib/api/integrations-types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Stat } from '@/components/fixed-assets/shared';
import { HealthBadge, IntegrationStatusBadge } from './shared';

type Filter = 'ALL' | 'CONNECTED' | 'ATTENTION' | 'DISABLED' | 'AVAILABLE';

/** Integrations catalogue: connected / needs attention / disabled, plus the provider catalogue to connect from. */
export function IntegrationsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const table = useTableState({ pageSize: 25 });
  const [filter, setFilter] = React.useState<Filter>(
    params.get('tab') === 'available'
      ? 'AVAILABLE'
      : params.get('filter') === 'attention'
        ? 'ATTENTION'
        : params.get('filter') === 'connected'
          ? 'CONNECTED'
          : 'ALL',
  );
  const [connecting, setConnecting] = React.useState<ProviderDescriptor | null>(null);
  const list = useIntegrations({ ...table.query, pageSize: 200 });
  const providers = useProviders();
  const action = useIntegrationAction();
  const sync = useTriggerSync();
  const items = React.useMemo(() => {
    const all = list.data?.items ?? [];
    switch (filter) {
      case 'CONNECTED':
        return all.filter((i) => i.status === 'CONNECTED' || i.status === 'SYNCING');
      case 'ATTENTION':
        return all.filter(
          (i) =>
            i.status === 'ERROR' || i.healthStatus === 'DEGRADED' || i.healthStatus === 'UNHEALTHY',
        );
      case 'DISABLED':
        return all.filter((i) => i.status === 'DISABLED' || i.status === 'DISCONNECTED');
      default:
        return all;
    }
  }, [list.data, filter]);
  const counts = React.useMemo(() => {
    const all = list.data?.items ?? [];
    return {
      connected: all.filter((i) => i.status === 'CONNECTED' || i.status === 'SYNCING').length,
      attention: all.filter(
        (i) =>
          i.status === 'ERROR' || i.healthStatus === 'UNHEALTHY' || i.healthStatus === 'DEGRADED',
      ).length,
      disabled: all.filter((i) => i.status === 'DISABLED' || i.status === 'DISCONNECTED').length,
    };
  }, [list.data]);
  const run = (id: string, a: 'connect' | 'disconnect' | 'test', label: string) =>
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
  const columns = React.useMemo<ColumnDef<IntegrationView>[]>(
    () => [
      {
        id: 'name',
        header: 'Integration',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.name}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.providerName} · {titleCase(row.original.category)}
              {row.original.demo ? (
                <Badge variant="outline" className="ml-2">
                  demo
                </Badge>
              ) : null}
            </div>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <IntegrationStatusBadge status={row.original.status} />,
      },
      {
        id: 'health',
        header: 'Health',
        enableSorting: false,
        cell: ({ row }) => (
          <HealthBadge status={row.original.healthStatus} score={row.original.healthScore} />
        ),
      },
      {
        id: 'auth',
        header: 'Auth',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.authType}</span>,
      },
      {
        id: 'lastSync',
        header: 'Last sync',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {formatDateTime(row.original.lastSyncAt)}
          </span>
        ),
      },
      {
        id: 'next',
        header: 'Next sync',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.syncSchedule ? formatDateTime(row.original.nextSyncAt) : 'manual'}
          </span>
        ),
      },
      {
        id: 'error',
        header: 'Last failure',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.lastError ? (
            <span className="line-clamp-1 max-w-72 text-xs text-critical">
              {row.original.lastError}
            </span>
          ) : null,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => {
          const i = row.original;
          return (
            <Can permissions={[P['integration.manage']]}>
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                {i.status === 'DISCONNECTED' || i.status === 'ERROR' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => run(i.id, 'connect', 'Connected')}
                  >
                    <Plug /> Connect
                  </Button>
                ) : null}
                {i.status === 'CONNECTED' && i.capabilities.includes('PULL') ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      sync.mutate(
                        { id: i.id },
                        {
                          onSuccess: () => toast.success('Sync queued'),
                          onError: (e) => toast.error(describeError(e)),
                        },
                      )
                    }
                  >
                    <RefreshCw /> Sync now
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => run(i.id, 'test', 'Tested')}>
                  <Zap /> Test
                </Button>
                {i.status !== 'DISCONNECTED' && i.status !== 'DISABLED' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => run(i.id, 'disconnect', 'Disconnected')}
                  >
                    <Unplug />
                  </Button>
                ) : null}
              </div>
            </Can>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const total = list.data?.total ?? 0;
  return (
    <>
      <PageHeader
        title="Integrations"
        description="External systems connect through adapters that feed the domain modules; nothing here writes to the ledger directly."
      />
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Connected" value={counts.connected} />
        <Stat label="Needs attention" value={counts.attention} danger={counts.attention > 0} />
        <Stat label="Disabled / disconnected" value={counts.disabled} />
        <Stat label="Available providers" value={providers.data?.length ?? '-'} />
      </div>
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="ALL">All ({total})</TabsTrigger>
          <TabsTrigger value="CONNECTED">Connected</TabsTrigger>
          <TabsTrigger value="ATTENTION">Needs attention</TabsTrigger>
          <TabsTrigger value="DISABLED">Disabled</TabsTrigger>
          <TabsTrigger value="AVAILABLE">Available</TabsTrigger>
        </TabsList>
      </Tabs>
      {filter === 'AVAILABLE' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(providers.data ?? []).map((p) => (
            <div
              key={p.provider}
              className="flex flex-col rounded-lg border p-4"
              data-testid="provider-card"
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">{p.name}</div>
                <Badge variant="outline">{titleCase(p.category)}</Badge>
              </div>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">{p.description}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {p.capabilities.map((c) => (
                  <Badge key={c} variant="secondary">
                    {titleCase(c)}
                  </Badge>
                ))}
                <Badge variant="outline" className="font-mono">
                  {p.authType}
                </Badge>
              </div>
              <Can permissions={[P['integration.manage']]}>
                <Button className="mt-3 self-start" size="sm" onClick={() => setConnecting(p)}>
                  <Plug /> Connect
                </Button>
              </Can>
            </div>
          ))}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={list.data ? { ...list.data, items, total: items.length } : undefined}
          isLoading={list.isLoading}
          isFetching={list.isFetching}
          pagination={table.pagination}
          getRowId={(r) => r.id}
          onRowClick={(r) => router.push(`/admin/integrations/${r.id}`)}
          emptyState={
            <EmptyState
              icon={Cable}
              title="No integrations"
              description="Connect a provider from the Available tab."
            />
          }
        />
      )}
      <ConnectDialog provider={connecting} onClose={() => setConnecting(null)} />
    </>
  );
}

// ------------------------------------------------------------------ connect

function ConnectDialog({
  provider,
  onClose,
}: {
  provider: ProviderDescriptor | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const { activeCompany } = useSession();
  const create = useCreateIntegration();
  const oauth = useOAuthStart();
  const [name, setName] = React.useState('');
  const [credentials, setCredentials] = React.useState<Record<string, string>>({});
  const [config, setConfig] = React.useState('{}');
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [schedule, setSchedule] = React.useState('');
  React.useEffect(() => {
    if (provider) {
      setName(provider.name);
      setCredentials({});
      setConfig(
        JSON.stringify(Object.fromEntries(provider.configFields.map((f) => [f, ''])), null, 2),
      );
      setScopes([]);
      setSchedule('');
    }
  }, [provider]);
  if (!provider) return null;
  const SCOPE_OPTIONS = [
    'customers:read',
    'customers:write',
    'invoices:read',
    'invoices:write',
    'invoices:post',
    'payments:write',
    'payments:post',
    'banking:read',
    'banking:write',
    'products:read',
  ];
  const submit = () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config || '{}') as Record<string, unknown>;
      for (const k of Object.keys(parsed)) if (parsed[k] === '') delete parsed[k];
    } catch {
      toast.error('Configuration must be valid JSON');
      return;
    }
    const creds = Object.fromEntries(Object.entries(credentials).filter(([, v]) => v));
    create.mutate(
      {
        provider: provider.provider,
        name,
        companyId: activeCompany?.id ?? null,
        config: parsed,
        scopes: scopes as never[],
        credentials: Object.keys(creds).length ? (creds as never) : undefined,
        syncSchedule: schedule || null,
        connect: provider.authType !== 'OAUTH2',
      },
      {
        onSuccess: async (created) => {
          if (provider.authType === 'OAUTH2') {
            const { authorizationUrl } = await oauth.mutateAsync({
              id: created.id,
              returnTo: `/admin/integrations/${created.id}`,
            });
            window.location.assign(authorizationUrl);
            return;
          }
          toast[created.status === 'CONNECTED' ? 'success' : 'warning'](
            created.status === 'CONNECTED'
              ? `${created.name} connected`
              : `${created.name} saved but not connected: ${created.lastError ?? 'see logs'}`,
          );
          onClose();
          router.push(`/admin/integrations/${created.id}`);
        },
        onError: (e) => toast.error(describeError(e)),
      },
    );
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Connect {provider.name}</DialogTitle>
          <DialogDescription>
            {provider.description} Secrets are encrypted before storage and never shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="integration-name"
            />
          </div>
          {provider.credentialFields.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label>
                {f.label}
                {f.required ? ' *' : ''}
              </Label>
              <Input
                type="password"
                autoComplete="off"
                value={credentials[f.key] ?? ''}
                onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })}
                data-testid={`credential-${f.key}`}
              />
            </div>
          ))}
          <div className="space-y-1">
            <Label>
              Configuration (JSON) - fields: {provider.configFields.join(', ') || 'none'}
            </Label>
            <Textarea
              rows={5}
              className="font-mono text-xs"
              value={config}
              onChange={(e) => setConfig(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Scopes granted to this integration</Label>
            <div className="grid grid-cols-2 gap-1 md:grid-cols-3">
              {SCOPE_OPTIONS.map((s) => (
                <label key={s} className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={scopes.includes(s)}
                    onCheckedChange={(on) =>
                      setScopes(on ? [...scopes, s] : scopes.filter((x) => x !== s))
                    }
                  />
                  <span className="font-mono text-xs">{s}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Posting scopes (`:post`) are explicit and never granted by default.
            </p>
          </div>
          {provider.capabilities.includes('PULL') ? (
            <div className="space-y-1">
              <Label>Sync schedule (cron, optional)</Label>
              <Select
                value={schedule || 'manual'}
                onValueChange={(v) => setSchedule(v === 'manual' ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual only</SelectItem>
                  <SelectItem value="*/15 * * * *">Every 15 minutes</SelectItem>
                  <SelectItem value="0 * * * *">Hourly</SelectItem>
                  <SelectItem value="0 2 * * *">Daily at 02:00</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={create.isPending || oauth.isPending}
            data-testid="integration-connect"
          >
            <Plug /> {provider.authType === 'OAUTH2' ? 'Save and authorise' : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function statusLabel(status: IntegrationStatus): string {
  return titleCase(status);
}
