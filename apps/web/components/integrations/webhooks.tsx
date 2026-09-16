'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Plus, RotateCw, Send, Trash2, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
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
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateWebhook,
  useDeleteWebhook,
  useUpdateWebhook,
  useWebhookAction,
  useWebhookDeliveries,
  useWebhookEventTypes,
  useWebhooks,
} from '@/lib/api/integrations-hooks';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { DeliveryStatusBadge, SecretRevealDialog } from './shared';

/** Outbound webhook subscriptions and their delivery history (signed, retried, replayable). */
export function WebhooksPage() {
  const hooks = useWebhooks();
  const update = useUpdateWebhook();
  const act = useWebhookAction();
  const remove = useDeleteWebhook();
  const params = useSearchParams();
  const [creating, setCreating] = React.useState(params.get('action') === 'create');
  const [secret, setSecret] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState('ALL');
  const deliveries = useWebhookDeliveries({
    pageSize: 50,
    status: status === 'ALL' ? undefined : (status as never),
  });
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Events are written to a transactional outbox with the business change and delivered with an HMAC signature, exponential retries and replay. Nothing is dropped silently."
        actions={
          <Can permissions={[P['webhook.manage']]}>
            <Button onClick={() => setCreating(true)} data-testid="webhook-create">
              <Plus /> New webhook
            </Button>
          </Can>
        }
      />
      <Tabs defaultValue="subscriptions">
        <TabsList>
          <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
        </TabsList>
        <TabsContent value="subscriptions">
          {hooks.data && hooks.data.length === 0 ? (
            <EmptyState
              icon={Webhook}
              title="No webhooks"
              description="Subscribe an endpoint to business events."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Pending</TableHead>
                  <TableHead>Exhausted</TableHead>
                  <TableHead>Last success</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(hooks.data ?? []).map((w) => (
                  <TableRow key={w.id} data-testid="webhook-row">
                    <TableCell className="font-medium">{w.name}</TableCell>
                    <TableCell className="max-w-72 truncate font-mono text-xs">{w.url}</TableCell>
                    <TableCell>
                      <div className="flex max-w-80 flex-wrap gap-1">
                        {w.events.map((e) => (
                          <Badge key={e} variant="secondary" className="font-mono text-[10px]">
                            {e}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={w.status === 'ACTIVE' ? 'success' : 'outline'}>
                        {w.status}
                      </Badge>
                      {w.disabledReason ? (
                        <div className="text-xs text-muted-foreground">{w.disabledReason}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono">{w.pendingDeliveries}</TableCell>
                    <TableCell
                      className={`font-mono ${w.exhaustedDeliveries ? 'text-critical' : ''}`}
                    >
                      {w.exhaustedDeliveries}
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(w.lastSuccessAt)}</TableCell>
                    <TableCell>
                      <Can permissions={[P['webhook.manage']]}>
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              act.mutate(
                                { id: w.id, action: 'test' },
                                {
                                  onSuccess: (d) =>
                                    toast[d.status === 'DELIVERED' ? 'success' : 'error'](
                                      `Test ${d.status.toLowerCase()}${d.lastHttpStatus ? ` (HTTP ${d.lastHttpStatus})` : ''}${d.responseTimeMs ? ` in ${d.responseTimeMs} ms` : ''}`,
                                    ),
                                  onError: (e) => toast.error(describeError(e)),
                                },
                              )
                            }
                            data-testid="webhook-test"
                          >
                            <Send /> Test
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              act.mutate(
                                { id: w.id, action: 'replay' },
                                {
                                  onSuccess: (r) =>
                                    toast.success(`${r.replayed ?? 0} delivery(ies) replayed`),
                                  onError: (e) => toast.error(describeError(e)),
                                },
                              )
                            }
                          >
                            <RotateCw /> Replay failed
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              act.mutate(
                                { id: w.id, action: 'rotate-secret' },
                                {
                                  onSuccess: (r) => setSecret(r.secret ?? null),
                                  onError: (e) => toast.error(describeError(e)),
                                },
                              )
                            }
                          >
                            Rotate secret
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              update.mutate(
                                { id: w.id, status: w.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
                                { onError: (e) => toast.error(describeError(e)) },
                              )
                            }
                          >
                            {w.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDeleting(w.id)}>
                            <Trash2 />
                          </Button>
                        </div>
                      </Can>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
        <TabsContent value="deliveries">
          <div className="mb-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {['PENDING', 'RETRYING', 'DELIVERED', 'FAILED', 'EXHAUSTED', 'DISABLED'].map(
                  (s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Webhook</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>HTTP</TableHead>
                <TableHead>Next attempt</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(deliveries.data?.items ?? []).map((d) => (
                <TableRow key={d.id} data-testid="webhook-delivery">
                  <TableCell className="text-xs">{formatDateTime(d.createdAt)}</TableCell>
                  <TableCell>
                    {d.webhookName}
                    {d.replayOfId ? (
                      <Badge variant="outline" className="ml-1">
                        replay
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{d.eventType}</TableCell>
                  <TableCell>
                    <DeliveryStatusBadge status={d.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {d.attempts}/{d.maxAttempts}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{d.lastHttpStatus ?? ''}</TableCell>
                  <TableCell className="text-xs">
                    {d.nextAttemptAt ? formatDateTime(d.nextAttemptAt) : ''}
                  </TableCell>
                  <TableCell className="max-w-80 truncate text-xs text-critical">
                    {d.lastError}
                  </TableCell>
                </TableRow>
              ))}
              {deliveries.data && deliveries.data.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    No deliveries.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
      <CreateWebhookDialog open={creating} onOpenChange={setCreating} onCreated={setSecret} />
      <SecretRevealDialog
        secret={secret}
        title="Webhook signing secret"
        description="Use it to verify X-Webhook-Signature (t=<unix>,v1=<hmac-sha256 of `t.body`>). It is shown once."
        onClose={() => setSecret(null)}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this webhook?"
        description="Its delivery history is removed with it."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(deleting!, {
            onSuccess: () => {
              setDeleting(null);
              toast.success('Webhook deleted');
            },
            onError: (e) => toast.error(describeError(e)),
          })
        }
      />
    </>
  );
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (secret: string) => void;
}) {
  const { me } = useSession();
  const types = useWebhookEventTypes();
  const create = useCreateWebhook();
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [events, setEvents] = React.useState<string[]>([]);
  const [companyId, setCompanyId] = React.useState('ALL');
  const [maxAttempts, setMaxAttempts] = React.useState('8');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New webhook subscription</DialogTitle>
          <DialogDescription>
            Deliveries are signed with a secret generated now and shown once.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="webhook-name"
              />
            </div>
            <div className="space-y-1">
              <Label>Max attempts</Label>
              <Input
                inputMode="numeric"
                value={maxAttempts}
                onChange={(e) => setMaxAttempts(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Endpoint URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/hooks/accounting"
              data-testid="webhook-url"
            />
          </div>
          <div className="space-y-1">
            <Label>Company</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All companies</SelectItem>
                {me.companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} - {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Events</Label>
            <div className="grid max-h-56 grid-cols-2 gap-1 overflow-auto rounded-md border p-2 md:grid-cols-3">
              {(types.data ?? []).map((t) => (
                <label key={t} className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={events.includes(t)}
                    onCheckedChange={(on) =>
                      setEvents(on ? [...events, t] : events.filter((x) => x !== t))
                    }
                  />
                  <span className="font-mono">{t}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!name || !url || events.length === 0}
            data-testid="webhook-submit"
            onClick={() =>
              create.mutate(
                {
                  name,
                  url,
                  events: events as never[],
                  companyId: companyId === 'ALL' ? null : companyId,
                  maxAttempts: Number(maxAttempts) || 8,
                },
                {
                  onSuccess: (w) => {
                    onOpenChange(false);
                    onCreated(w.secret);
                    setName('');
                    setUrl('');
                    setEvents([]);
                  },
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <Webhook /> Create webhook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
