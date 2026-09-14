'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Plus, ShieldCheck, Trash2, UserCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { formatMoney } from '@accounting/money';
import { DELEGATION_APPROVAL_POLICIES, P, type DelegationStatus } from '@accounting/types';
import { createDelegationSchema, type CreateDelegationInput } from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCancelDelegation,
  useCreateDelegation,
  useDecideDelegation,
  useDelegablePermissions,
  useDelegation,
  useDelegationPolicy,
  useDelegationUsage,
  useDelegations,
  useRevokeDelegation,
  useUpdateDelegationPolicy,
} from '@/lib/api/delegations-hooks';
import { useBranches, useUsers } from '@/lib/api/hooks';
import type { DelegationView } from '@/lib/api/integrations-types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Stat } from '@/components/fixed-assets/shared';

const STATUS_VARIANT: Record<
  DelegationStatus,
  'secondary' | 'warning' | 'success' | 'outline' | 'destructive'
> = {
  PENDING: 'warning',
  ACTIVE: 'success',
  EXPIRED: 'outline',
  REVOKED: 'destructive',
  CANCELLED: 'outline',
  REJECTED: 'destructive',
};

export function DelegationStatusBadge({ status }: { status: DelegationStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{titleCase(status)}</Badge>;
}

type Section = 'mine' | 'created' | 'approve' | 'active' | 'pending' | 'expired';
const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'mine', label: 'My delegations' },
  { key: 'created', label: 'Delegations I created' },
  { key: 'approve', label: 'Delegations I approve' },
  { key: 'active', label: 'Active' },
  { key: 'pending', label: 'Pending' },
  { key: 'expired', label: 'Expired' },
];

function scopeSummary(d: DelegationView): string {
  return d.scopes.map((s) => s.permission).join(', ');
}

/** Delegated Authority dashboard: sections, create, approve / reject, revoke, cancel, usage. */
export function DelegationsPage() {
  const { me } = useSession();
  const params = useSearchParams();
  const table = useTableState({ pageSize: 25 });
  const [section, setSection] = React.useState<Section>(
    (SECTIONS.some((s) => s.key === params.get('section'))
      ? params.get('section')
      : 'mine') as Section,
  );
  const [creating, setCreating] = React.useState(params.get('action') === 'create');
  const [selected, setSelected] = React.useState<string | null>(null);
  const query = React.useMemo(() => {
    switch (section) {
      case 'mine':
        return { role: 'delegate' as const };
      case 'created':
        return { role: 'delegator' as const };
      case 'approve':
        return { role: 'approver' as const };
      case 'active':
        return { status: 'ACTIVE' as const };
      case 'pending':
        return { status: 'PENDING' as const };
      case 'expired':
        return { status: 'EXPIRED' as const };
    }
  }, [section]);
  const list = useDelegations({ ...table.query, ...query });
  const active = useDelegations({ status: 'ACTIVE', pageSize: 1 });
  const pending = useDelegations({ status: 'PENDING', pageSize: 1 });
  const columns = React.useMemo<ColumnDef<DelegationView>[]>(
    () => [
      {
        id: 'number',
        header: 'Delegation',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs font-medium">{row.original.delegationNumber}</span>
        ),
      },
      {
        id: 'delegator',
        header: 'Delegator',
        enableSorting: false,
        cell: ({ row }) => row.original.delegatorName,
      },
      {
        id: 'delegate',
        header: 'Delegate',
        enableSorting: false,
        cell: ({ row }) => row.original.delegateName,
      },
      {
        id: 'scope',
        header: 'Scope',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">{scopeSummary(row.original)}</span>,
      },
      {
        id: 'company',
        header: 'Company',
        enableSorting: false,
        cell: ({ row }) => row.original.companyCode,
      },
      {
        id: 'branch',
        header: 'Branch',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.scopes
            .map((s) => s.branchCode ?? 'All')
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(', '),
      },
      {
        id: 'limit',
        header: 'Amount limit',
        enableSorting: false,
        cell: ({ row }) => {
          const withLimit = row.original.scopes.filter((s) => s.maxAmount);
          return withLimit.length ? (
            withLimit
              .map((s) => `${s.currency ?? ''} ${formatMoney(s.maxAmount!, s.currency ?? 'PHP')}`)
              .join(' / ')
          ) : (
            <span className="text-muted-foreground">No limit</span>
          );
        },
      },
      {
        id: 'start',
        header: 'Start',
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.startAt)}</span>,
      },
      {
        id: 'end',
        header: 'End',
        enableSorting: false,
        cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.endAt)}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <DelegationStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );
  const myGrants = me.delegations ?? [];
  return (
    <>
      <PageHeader
        title="Delegated authority"
        description="Temporary, scoped and audited: a delegation lends approval authority the delegator holds, capped by amount and bounded in time. It is never a role change."
        actions={
          <Can permissions={[P['delegation.create']]}>
            <Button onClick={() => setCreating(true)} data-testid="delegation-create">
              <Plus /> New delegation
            </Button>
          </Can>
        }
      />
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Active" value={active.data?.total ?? '-'} />
        <Stat label="Pending approval" value={pending.data?.total ?? '-'} />
        <Stat
          label="Lent to me (this company)"
          value={myGrants.length}
          hint={myGrants.map((g) => g.permission).join(', ') || 'none'}
        />
        <PolicyCard />
      </div>
      <Tabs value={section} onValueChange={(v) => setSection(v as Section)}>
        <TabsList className="flex-wrap">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.key} value={s.key}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <DataTable
        columns={columns}
        data={list.data}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => setSelected(r.id)}
        emptyState={
          <EmptyState
            icon={UserCheck}
            title="No delegations"
            description="Nothing in this section."
          />
        }
      />
      <CreateDelegationDialog open={creating} onOpenChange={setCreating} />
      <DelegationDialog id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function PolicyCard() {
  const policy = useDelegationPolicy();
  const update = useUpdateDelegationPolicy();
  const { hasPermission } = useSession();
  if (!policy.data)
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">Policy...</CardContent>
      </Card>
    );
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Approval policy</div>
        {hasPermission(P['delegation.manage']) ? (
          <Select
            value={policy.data.approvalPolicy}
            onValueChange={(v) =>
              update.mutate(
                {
                  ...policy.data!,
                  approvalPolicy: v as (typeof DELEGATION_APPROVAL_POLICIES)[number],
                },
                {
                  onSuccess: () => toast.success('Delegation policy updated'),
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
          >
            <SelectTrigger className="mt-1 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DELEGATION_APPROVAL_POLICIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {titleCase(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="mt-1 text-lg font-semibold">{titleCase(policy.data.approvalPolicy)}</div>
        )}
        <div className="mt-1 text-xs text-muted-foreground">
          Max {policy.data.maxDurationDays} days · warn {policy.data.expiryWarningDays}d before
          expiry
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ create

type FormValues = z.input<typeof createDelegationSchema>;

function CreateDelegationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { me, activeCompany } = useSession();
  const create = useCreateDelegation();
  const permissions = useDelegablePermissions();
  const users = useUsers({ pageSize: 100, status: 'ACTIVE' });
  const branches = useBranches(activeCompany?.id);
  const toLocalInput = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const form = useForm<FormValues, unknown, CreateDelegationInput>({
    resolver: zodResolver(createDelegationSchema),
    defaultValues: {
      delegateUserId: '',
      companyId: activeCompany?.id ?? '',
      startAt: toLocalInput(new Date()),
      endAt: toLocalInput(new Date(Date.now() + 14 * 24 * 3600 * 1000)),
      reason: '',
      scopes: [{ permission: 'bill.approve', maxAmount: '', branchId: null }],
    },
  });
  const scopes = useFieldArray({ control: form.control, name: 'scopes' });
  React.useEffect(() => {
    if (open) form.reset({ ...form.getValues(), companyId: activeCompany?.id ?? '' });
  }, [open, activeCompany?.id, form]);
  const submit = form.handleSubmit((values) => {
    const normalise = (v: string) => (v.length === 16 ? new Date(v).toISOString() : v);
    create.mutate(
      {
        ...values,
        startAt: normalise(values.startAt),
        endAt: normalise(values.endAt),
        scopes: values.scopes.map((s) => ({
          ...s,
          maxAmount: s.maxAmount ? s.maxAmount : null,
          branchId: s.branchId || null,
        })),
      },
      {
        onSuccess: (d) => {
          toast.success(
            `${d.delegationNumber} ${d.status === 'ACTIVE' ? 'is active' : 'is awaiting approval'}`,
          );
          onOpenChange(false);
          form.reset();
        },
        onError: (e) => toast.error(describeError(e)),
      },
    );
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Delegate approval authority</DialogTitle>
          <DialogDescription>
            You can only delegate permissions you hold in{' '}
            {activeCompany?.code ?? 'the active company'}. The delegate never gains more than you
            have, and every use is recorded.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-4">
            <FormField
              control={form.control}
              name="delegateUserId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Delegate</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger data-testid="delegation-delegate">
                        <SelectValue placeholder="Choose a user" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(users.data?.items ?? [])
                        .filter((u) => u.id !== me.user.id)
                        .map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.firstName} {u.lastName} · {u.email}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <FormField
                control={form.control}
                name="startAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End</FormLabel>
                    <FormControl>
                      <Input type="datetime-local" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="e.g. Leave coverage 1-15 October" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Scope</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    scopes.append({ permission: 'bill.approve', maxAmount: '', branchId: null })
                  }
                >
                  <Plus /> Add permission
                </Button>
              </div>
              {scopes.fields.map((f, i) => (
                <div
                  key={f.id}
                  className="grid items-end gap-2 rounded-md border p-2 md:grid-cols-[1fr_1fr_1fr_auto]"
                >
                  <FormField
                    control={form.control}
                    name={`scopes.${i}.permission`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Permission</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {(permissions.data ?? []).map((p) => (
                              <SelectItem key={p.permission} value={p.permission}>
                                {p.label} <span className="text-muted-foreground">({p.area})</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`scopes.${i}.branchId`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Branch</FormLabel>
                        <Select
                          value={field.value ?? 'ALL'}
                          onValueChange={(v) => field.onChange(v === 'ALL' ? null : v)}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="ALL">All branches</SelectItem>
                            {(branches.data ?? []).map((b) => (
                              <SelectItem key={b.id} value={b.id}>
                                {b.code} - {b.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`scopes.${i}.maxAmount`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">
                          Max amount ({activeCompany?.baseCurrency ?? 'PHP'})
                        </FormLabel>
                        <FormControl>
                          <Input
                            inputMode="decimal"
                            placeholder="No limit"
                            {...field}
                            value={field.value ?? ''}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={scopes.fields.length === 1}
                    onClick={() => scopes.remove(i)}
                    aria-label="Remove scope"
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending} data-testid="delegation-submit">
                <ShieldCheck /> Create delegation
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ detail

function DelegationDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { me, hasPermission } = useSession();
  const detail = useDelegation(id);
  const usage = useDelegationUsage(id);
  const decide = useDecideDelegation();
  const revoke = useRevokeDelegation();
  const cancel = useCancelDelegation();
  const [comment, setComment] = React.useState('');
  const [revoking, setRevoking] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const d = detail.data;
  const isDelegator = d?.delegatorUserId === me.user.id || d?.createdBy === me.user.id;
  const mayRevoke =
    d &&
    (d.status === 'ACTIVE' || d.status === 'PENDING') &&
    (isDelegator || hasPermission(P['delegation.manage']));
  const run = (decision: 'APPROVE' | 'REJECT') =>
    decide.mutate(
      { id: id!, decision, comment: comment || undefined },
      {
        onSuccess: (r) =>
          toast.success(
            `${r.delegationNumber} ${r.status === 'ACTIVE' ? 'activated' : titleCase(r.status)}`,
          ),
        onError: (e) => toast.error(describeError(e)),
      },
    );
  return (
    <Dialog open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        {d ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="font-mono">{d.delegationNumber}</span>{' '}
                <DelegationStatusBadge status={d.status} />
                {d.inEffect ? <Badge variant="success">In effect</Badge> : null}
              </DialogTitle>
              <DialogDescription>{d.reason}</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Delegator</dt>
              <dd>
                {d.delegatorName} <span className="text-muted-foreground">{d.delegatorEmail}</span>
              </dd>
              <dt className="text-muted-foreground">Delegate</dt>
              <dd>
                {d.delegateName} <span className="text-muted-foreground">{d.delegateEmail}</span>
              </dd>
              <dt className="text-muted-foreground">Company</dt>
              <dd>
                {d.companyCode} - {d.companyName}
              </dd>
              <dt className="text-muted-foreground">Window</dt>
              <dd>
                {formatDateTime(d.startAt)} - {formatDateTime(d.endAt)}
              </dd>
              <dt className="text-muted-foreground">Approvals</dt>
              <dd>
                {d.approvals.length} of {d.requiredApprovals} required
                {d.approvals
                  .map(
                    (a) => ` · ${a.approverName ?? a.approverUserId} ${a.decision.toLowerCase()}`,
                  )
                  .join('')}
              </dd>
              <dt className="text-muted-foreground">Used</dt>
              <dd>{d.usageCount} time(s)</dd>
              {d.revokeReason ? (
                <>
                  <dt className="text-muted-foreground">Revoked</dt>
                  <dd>{d.revokeReason}</dd>
                </>
              ) : null}
              {d.rejectionReason ? (
                <>
                  <dt className="text-muted-foreground">Rejected</dt>
                  <dd>{d.rejectionReason}</dd>
                </>
              ) : null}
            </dl>
            <div>
              <Label>Scope</Label>
              <ul className="mt-1 divide-y rounded-md border text-sm">
                {d.scopes.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="font-mono text-xs">{s.permission}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.branchCode ? `Branch ${s.branchCode}` : 'All branches'}
                    </span>
                    <span className="text-xs">
                      {s.maxAmount
                        ? `${s.currency ?? ''} ${formatMoney(s.maxAmount, s.currency ?? 'PHP')}`
                        : 'No limit'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {usage.data && usage.data.length > 0 ? (
              <div>
                <Label>Usage</Label>
                <ul className="mt-1 max-h-40 divide-y overflow-auto rounded-md border text-xs">
                  {usage.data.map((u) => (
                    <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span>
                        {u.action}{' '}
                        {u.documentNumber ? (
                          <span className="font-mono">{u.documentNumber}</span>
                        ) : null}
                      </span>
                      <span className="text-muted-foreground">
                        {u.amount
                          ? `${u.currency ?? ''} ${formatMoney(u.amount, u.currency ?? 'PHP')} · `
                          : ''}
                        {formatDateTime(u.usedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {d.canApprove ? (
              <div className="space-y-1">
                <Label>Comment</Label>
                <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
            ) : null}
            <DialogFooter className="flex-wrap">
              {d.status === 'PENDING' && isDelegator ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    cancel.mutate(id!, {
                      onSuccess: () => toast.success('Delegation cancelled'),
                      onError: (e) => toast.error(describeError(e)),
                    })
                  }
                >
                  Cancel delegation
                </Button>
              ) : null}
              {mayRevoke && d.status === 'ACTIVE' ? (
                <Button
                  variant="destructive"
                  onClick={() => setRevoking(true)}
                  data-testid="delegation-revoke"
                >
                  Revoke
                </Button>
              ) : null}
              {d.canApprove ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => run('REJECT')}
                    loading={decide.isPending}
                  >
                    <X /> Reject
                  </Button>
                  <Button
                    onClick={() => run('APPROVE')}
                    loading={decide.isPending}
                    data-testid="delegation-approve"
                  >
                    <Check /> Approve
                  </Button>
                </>
              ) : null}
            </DialogFooter>
            <ConfirmDialog
              open={revoking}
              onOpenChange={setRevoking}
              title={`Revoke ${d.delegationNumber}?`}
              description={
                <div className="space-y-2">
                  <p>The delegate loses this authority immediately.</p>
                  <Textarea
                    rows={2}
                    placeholder="Reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              }
              confirmLabel="Revoke"
              destructive
              loading={revoke.isPending}
              onConfirm={() =>
                revoke.mutate(
                  { id: id!, reason },
                  {
                    onSuccess: () => {
                      setRevoking(false);
                      toast.success('Delegation revoked');
                    },
                    onError: (e) => toast.error(describeError(e)),
                  },
                )
              }
            />
          </>
        ) : (
          <DialogHeader>
            <DialogTitle>Loading...</DialogTitle>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}
