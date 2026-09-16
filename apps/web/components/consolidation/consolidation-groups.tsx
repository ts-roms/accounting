'use client';
import * as React from 'react';
import Link from 'next/link';
import { Plus, Save, Wand2 } from 'lucide-react';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAutoMap,
  useConsolidationGroups,
  useCreateConsolidationGroup,
  useGroupAccounts,
  useGroupMappings,
  useSaveGroupMappings,
  useUpdateConsolidationGroup,
} from '@/lib/api/consolidation-hooks';
import type { ConsolidationGroupView } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';

const NONE = '__none__';

/** Administration → Consolidation groups: members / ownership, the group chart and member-account mappings. */
export function ConsolidationGroupsPage() {
  const groups = useConsolidationGroups();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const list = groups.data ?? [];
  const group = list.find((g) => g.id === selected) ?? list[0] ?? null;
  return (
    <>
      <PageHeader
        title="Consolidation groups"
        description="A group names the parent, the presentation currency and its members with ownership share and method (FULL carries 100% and reports NCI; PROPORTIONATE scales by the share). Member accounts map onto the group chart of accounts."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/reports/consolidation">Open consolidation</Link>
            </Button>
            <Can permissions={[P['consolidation.manage']]}>
              <Button onClick={() => setCreating(true)} data-testid="group-create">
                <Plus /> New group
              </Button>
            </Can>
          </div>
        }
      />
      {groups.isError ? (
        <ErrorState description={describeError(groups.error)} />
      ) : groups.isLoading ? (
        <TableSkeleton rows={4} />
      ) : list.length === 0 ? (
        <EmptyState
          title="No groups yet"
          description="Create the first consolidation group to start mapping member charts."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Card>
            <CardContent className="p-0">
              <Table data-testid="group-list">
                <TableHeader>
                  <TableRow>
                    <TableHead>Group</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead className="text-right">Chart</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((g) => (
                    <TableRow
                      key={g.id}
                      className="cursor-pointer"
                      data-testid="group-row"
                      data-code={g.code}
                      data-state={group?.id === g.id ? 'selected' : undefined}
                      onClick={() => setSelected(g.id)}
                    >
                      <TableCell>
                        <div className="font-mono text-xs font-medium">{g.code}</div>
                        <div className="text-xs text-muted-foreground">
                          {g.name} · {g.presentationCurrency}
                          {g.status === 'INACTIVE' ? ' · inactive' : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {g.members.map((m) => (
                          <div key={m.companyId}>
                            {m.code}{' '}
                            {m.isParent
                              ? '(parent)'
                              : `${Number(m.ownershipPct)}% ${m.method.toLowerCase()}`}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell className="text-right tabular">{g.groupAccountCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {group ? <MappingsPanel group={group} /> : null}
        </div>
      )}
      {creating ? (
        <CreateGroupDialog
          onClose={() => setCreating(false)}
          onCreated={(g) => setSelected(g.id)}
        />
      ) : null}
    </>
  );
}

function CreateGroupDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (g: ConsolidationGroupView) => void;
}) {
  const { me } = useSession();
  const create = useCreateConsolidationGroup();
  const companies = me?.companies ?? [];
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [currency, setCurrency] = React.useState(me?.organization.baseCurrency ?? 'PHP');
  const [parentId, setParentId] = React.useState(companies[0]?.id ?? '');
  const [members, setMembers] = React.useState<
    Record<string, { pct: string; method: 'FULL' | 'PROPORTIONATE' }>
  >({});
  const toggle = (id: string) =>
    setMembers((m) => {
      const next = { ...m };
      if (next[id]) delete next[id];
      else next[id] = { pct: '100', method: 'FULL' };
      return next;
    });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New consolidation group</DialogTitle>
          <DialogDescription>
            The parent is always a 100% member; tick the subsidiaries and set their share and
            method.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="grp-code">Code</Label>
            <Input
              id="grp-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              data-testid="group-code"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="grp-name">Name</Label>
            <Input
              id="grp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="group-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="grp-ccy">Presentation currency</Label>
            <Input
              id="grp-ccy"
              value={currency}
              maxLength={3}
              className="font-mono uppercase"
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              data-testid="group-currency"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="grp-parent">Parent company</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger id="grp-parent" data-testid="group-parent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Subsidiary</TableHead>
              <TableHead className="w-28">Share %</TableHead>
              <TableHead className="w-44">Method</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {companies
              .filter((c) => c.id !== parentId)
              .map((c) => (
                <TableRow key={c.id} data-testid="group-member" data-code={c.code}>
                  <TableCell>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={Boolean(members[c.id])}
                        onChange={() => toggle(c.id)}
                        data-testid="group-member-toggle"
                      />
                      {c.code} {c.name}
                    </label>
                  </TableCell>
                  <TableCell>
                    <Input
                      inputMode="decimal"
                      disabled={!members[c.id]}
                      value={members[c.id]?.pct ?? ''}
                      onChange={(e) =>
                        setMembers((m) => ({ ...m, [c.id]: { ...m[c.id]!, pct: e.target.value } }))
                      }
                      data-testid="group-member-pct"
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      disabled={!members[c.id]}
                      value={members[c.id]?.method ?? 'FULL'}
                      onValueChange={(v) =>
                        setMembers((m) => ({
                          ...m,
                          [c.id]: { ...m[c.id]!, method: v as 'FULL' | 'PROPORTIONATE' },
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FULL">Full</SelectItem>
                        <SelectItem value="PROPORTIONATE">Proportionate</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!code || !name || !parentId || currency.length !== 3 || create.isPending}
            data-testid="group-save"
            onClick={() =>
              create.mutate(
                {
                  code,
                  name,
                  presentationCurrency: currency,
                  parentCompanyId: parentId,
                  members: Object.entries(members).map(([companyId, m]) => ({
                    companyId,
                    ownershipPct: Number(m.pct) || 100,
                    method: m.method,
                  })),
                },
                {
                  onSuccess: (g) => {
                    toast.success(`Created ${g.code}`);
                    onCreated(g);
                    onClose();
                  },
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <Save /> Create group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MappingsPanel({ group }: { group: ConsolidationGroupView }) {
  const [companyId, setCompanyId] = React.useState(group.members[0]?.companyId ?? null);
  React.useEffect(() => {
    if (!group.members.some((m) => m.companyId === companyId))
      setCompanyId(group.members[0]?.companyId ?? null);
  }, [group, companyId]);
  const accounts = useGroupAccounts(group.id);
  const mappings = useGroupMappings(group.id, companyId);
  const save = useSaveGroupMappings();
  const auto = useAutoMap();
  const update = useUpdateConsolidationGroup();
  const [draft, setDraft] = React.useState<Record<string, string | null>>({});
  React.useEffect(() => setDraft({}), [companyId, mappings.data]);
  const rows = mappings.data ?? [];
  const unmapped = rows.filter(
    (r) => !r.isHeader && !(draft[r.accountId] ?? r.groupAccountId),
  ).length;
  const changed = Object.keys(draft).length;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="mr-auto">
          {group.code} · chart mappings
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {group.groupAccountCount} group accounts
          </span>
        </CardTitle>
        <Select value={companyId ?? ''} onValueChange={setCompanyId}>
          <SelectTrigger className="w-56" data-testid="mapping-company">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {group.members.map((m) => (
              <SelectItem key={m.companyId} value={m.companyId}>
                {m.code} {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Can permissions={[P['consolidation.manage']]}>
          <Button
            size="sm"
            variant="outline"
            disabled={auto.isPending}
            data-testid="mapping-auto"
            onClick={() =>
              auto.mutate(
                { groupId: group.id, createMissing: true },
                {
                  onSuccess: (r) =>
                    toast.success(
                      `Mapped ${r.mapped} account${r.mapped === 1 ? '' : 's'}, created ${r.created}${r.unmapped.length ? `, ${r.unmapped.length} left unmapped` : ''}`,
                    ),
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <Wand2 /> Auto-map by code
          </Button>
          <Button
            size="sm"
            disabled={!changed || save.isPending || !companyId}
            data-testid="mapping-save"
            onClick={() =>
              save.mutate(
                {
                  groupId: group.id,
                  companyId: companyId!,
                  mappings: Object.entries(draft).map(([accountId, groupAccountId]) => ({
                    accountId,
                    groupAccountId,
                  })),
                },
                {
                  onSuccess: () => toast.success('Mappings saved'),
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <Save /> Save {changed ? `(${changed})` : ''}
          </Button>
          {group.status === 'ACTIVE' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                update.mutate(
                  { id: group.id, status: 'INACTIVE' },
                  { onError: (e) => toast.error(describeError(e)) },
                )
              }
            >
              Deactivate
            </Button>
          ) : null}
        </Can>
      </CardHeader>
      <CardContent className="p-0">
        <div className="px-4 pb-2 text-xs text-muted-foreground" data-testid="mapping-summary">
          {unmapped === 0
            ? 'Every postable account is mapped.'
            : `${unmapped} postable account${unmapped === 1 ? '' : 's'} unmapped`}
        </div>
        {mappings.isError ? (
          <ErrorState description={describeError(mappings.error)} />
        ) : !mappings.data || !accounts.data ? (
          <TableSkeleton rows={8} />
        ) : (
          <Table data-testid="mapping-table">
            <TableHeader>
              <TableRow>
                <TableHead>Member account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Group account</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows
                .filter((r) => !r.isHeader)
                .map((r) => {
                  const value =
                    draft[r.accountId] === undefined ? r.groupAccountId : draft[r.accountId];
                  return (
                    <TableRow
                      key={r.accountId}
                      data-testid="mapping-row"
                      data-code={r.code}
                      data-mapped={value ? 'yes' : 'no'}
                    >
                      <TableCell>
                        <span className="font-mono text-xs">{r.code}</span> {r.name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.type}</Badge>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={value ?? NONE}
                          onValueChange={(v) =>
                            setDraft((d) => ({ ...d, [r.accountId]: v === NONE ? null : v }))
                          }
                        >
                          <SelectTrigger className="w-80" data-testid="mapping-target">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>— unmapped —</SelectItem>
                            {accounts.data
                              .filter((g) => g.type === r.type)
                              .map((g) => (
                                <SelectItem key={g.id} value={g.id}>
                                  {g.code} {g.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
