'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
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
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateApiKey,
  useApiKeys,
  useRevokeApiKey,
  useRotateApiKey,
  useScopeCatalog,
} from '@/lib/api/integrations-hooks';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { SecretRevealDialog } from './shared';

/** Internal API keys: scoped, company-limited, rate-limited; the secret is shown once. */
export function ApiKeysPage() {
  const keys = useApiKeys();
  const rotate = useRotateApiKey();
  const revoke = useRevokeApiKey();
  const params = useSearchParams();
  const [creating, setCreating] = React.useState(params.get('action') === 'create');
  const [secret, setSecret] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys act as their owner, narrowed to explicit scopes. No scope grants posting authority unless it is a :post scope, and a key can never exceed what its owner may do."
        actions={
          <Can permissions={[P['api-key.manage']]}>
            <Button onClick={() => setCreating(true)} data-testid="api-key-create">
              <Plus /> New API key
            </Button>
          </Can>
        }
      />
      {keys.data && keys.data.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create a key for an external system."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Companies</TableHead>
              <TableHead>Limit / min</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(keys.data ?? []).map((k) => (
              <TableRow key={k.id} data-testid="api-key-row">
                <TableCell>
                  <div className="font-medium">{k.name}</div>
                  <div className="text-xs text-muted-foreground">{k.description}</div>
                </TableCell>
                <TableCell className="font-mono text-xs">ak_{k.prefix}…</TableCell>
                <TableCell className="text-xs">{k.ownerName}</TableCell>
                <TableCell>
                  <div className="flex max-w-80 flex-wrap gap-1">
                    {k.scopes.map((s) => (
                      <Badge
                        key={s}
                        variant={s.endsWith(':post') ? 'warning' : 'secondary'}
                        className="font-mono text-[10px]"
                      >
                        {s}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  {k.companyIds.length ? `${k.companyIds.length} selected` : 'All accessible'}
                </TableCell>
                <TableCell className="font-mono text-xs">{k.rateLimitPerMinute}</TableCell>
                <TableCell className="text-xs">
                  {k.expiresAt ? formatDateTime(k.expiresAt) : 'never'}
                </TableCell>
                <TableCell className="text-xs">{formatDateTime(k.lastUsedAt)}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      k.effectiveStatus === 'ACTIVE'
                        ? 'success'
                        : k.effectiveStatus === 'EXPIRED'
                          ? 'warning'
                          : 'destructive'
                    }
                  >
                    {k.effectiveStatus}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Can permissions={[P['api-key.manage']]}>
                    {k.effectiveStatus === 'ACTIVE' ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            rotate.mutate(
                              { id: k.id, graceMinutes: 0 },
                              {
                                onSuccess: (r) => {
                                  setSecret(r.secret);
                                  toast.success('Key rotated');
                                },
                                onError: (e) => toast.error(describeError(e)),
                              },
                            )
                          }
                        >
                          <RotateCw /> Rotate
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRevoking(k.id)}>
                          <Trash2 /> Revoke
                        </Button>
                      </div>
                    ) : null}
                  </Can>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CreateApiKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(s) => setSecret(s)}
      />
      <SecretRevealDialog
        secret={secret}
        title="Your new API key"
        description="Copy it now - it is stored as a hash and cannot be shown again."
        onClose={() => setSecret(null)}
      />
      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this API key?"
        description="Requests using it will be rejected immediately. The key stays in the audit trail."
        confirmLabel="Revoke"
        destructive
        loading={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(
            { id: revoking! },
            {
              onSuccess: () => {
                setRevoking(null);
                toast.success('Key revoked');
              },
              onError: (e) => toast.error(describeError(e)),
            },
          )
        }
      />
    </>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (secret: string) => void;
}) {
  const { me } = useSession();
  const catalog = useScopeCatalog();
  const create = useCreateApiKey();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [companies, setCompanies] = React.useState<string[]>([]);
  const [expires, setExpires] = React.useState('');
  const [limit, setLimit] = React.useState('300');
  const granted = new Set(me.permissions);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            Scopes you cannot grant (permissions you do not hold) are disabled.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="api-key-name"
              />
            </div>
            <div className="space-y-1">
              <Label>Rate limit per minute</Label>
              <Input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Scopes</Label>
            <div className="grid max-h-64 grid-cols-1 gap-1 overflow-auto rounded-md border p-2 md:grid-cols-2">
              {(catalog.data ?? []).map((s) => {
                const allowed = s.permissions.every((p) => granted.has(p));
                return (
                  <label
                    key={s.scope}
                    className={`flex items-start gap-2 text-sm ${allowed ? '' : 'opacity-50'}`}
                  >
                    <Switch
                      disabled={!allowed}
                      checked={scopes.includes(s.scope)}
                      onCheckedChange={(on) =>
                        setScopes(on ? [...scopes, s.scope] : scopes.filter((x) => x !== s.scope))
                      }
                      data-testid={`scope-${s.scope}`}
                    />
                    <span>
                      <span className="font-mono text-xs">{s.scope}</span>
                      <span className="block text-xs text-muted-foreground">{s.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Company access</Label>
              <div className="space-y-1 rounded-md border p-2">
                {me.companies.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={companies.includes(c.id)}
                      onCheckedChange={(on) =>
                        setCompanies(
                          on ? [...companies, c.id] : companies.filter((x) => x !== c.id),
                        )
                      }
                    />{' '}
                    {c.code} - {c.name}
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">
                  None selected = every company you can access.
                </p>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Expires (optional)</Label>
              <Input
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={create.isPending}
            disabled={!name || scopes.length === 0}
            data-testid="api-key-submit"
            onClick={() =>
              create.mutate(
                {
                  name,
                  description: description || undefined,
                  scopes: scopes as never[],
                  companyIds: companies,
                  expiresAt: expires ? new Date(expires).toISOString() : null,
                  rateLimitPerMinute: Number(limit) || 300,
                },
                {
                  onSuccess: (k) => {
                    onOpenChange(false);
                    onCreated(k.secret);
                    setName('');
                    setScopes([]);
                    setCompanies([]);
                  },
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <KeyRound /> Create key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
