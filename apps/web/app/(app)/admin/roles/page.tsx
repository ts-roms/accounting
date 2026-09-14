'use client';
import * as React from 'react';
import { Lock, Plus, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { usePermissions, useRoles, useSetRolePermissions, useSodPolicies } from '@/lib/api/hooks';
import type { Permission, Role } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { CreateRoleDialog } from './create-role-dialog';

export default function RolesPage() {
  const roles = useRoles();
  const permissions = usePermissions();
  const sod = useSodPolicies();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0] ?? null;

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        description="Roles bundle fine-grained permissions. System roles are seeded per organization; custom roles can be tailored."
        actions={
          <Can permissions={[P['role.manage']]}>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New role
            </Button>
          </Can>
        }
      />
      <Tabs defaultValue="roles">
        <TabsList>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="sod">Segregation of duties</TabsTrigger>
        </TabsList>
        <TabsContent value="roles">
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>Roles</CardTitle>
                <CardDescription>{roles.data?.length ?? 0} defined</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {roles.isLoading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-9 w-full" />
                    ))
                  : roles.data?.map((role) => (
                      <button
                        key={role.id}
                        type="button"
                        onClick={() => setSelectedId(role.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent',
                          selected?.id === role.id && 'bg-accent',
                        )}
                      >
                        <span className="flex items-center gap-2">
                          {role.isSystem ? (
                            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          {role.name}
                        </span>
                        <span className="text-xs text-muted-foreground">{role.userCount}</span>
                      </button>
                    ))}
              </CardContent>
            </Card>
            {selected && permissions.data ? (
              <RoleEditor key={selected.id} role={selected} permissions={permissions.data} />
            ) : (
              <Skeleton className="h-96" />
            )}
          </div>
        </TabsContent>
        <TabsContent value="sod">
          <Card>
            <CardHeader>
              <CardTitle>Segregation-of-duties policies</CardTitle>
              <CardDescription>
                Pairs of permissions that should not be held by one person in the same company
                scope. BLOCK rejects the assignment; WARN records it in the audit trail.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {sod.data?.length ? (
                sod.data.map((p) => (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        <code>{p.permissionA}</code> + <code>{p.permissionB}</code>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={p.enforcement === 'BLOCK' ? 'destructive' : 'warning'}>
                        {p.enforcement}
                      </Badge>
                      {!p.isActive ? <Badge variant="secondary">inactive</Badge> : null}
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState
                  title="No policies"
                  description="Segregation-of-duties policies are seeded per organization."
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <CreateRoleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => setSelectedId(id)}
      />
    </>
  );
}

function RoleEditor({ role, permissions }: { role: Role; permissions: Permission[] }) {
  const { hasPermission } = useSession();
  const save = useSetRolePermissions();
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(role.permissions));
  const locked = role.isSystem && role.key === 'SUPER_ADMIN';
  const editable = hasPermission(P['role.manage']) && !locked;
  const dirty =
    selected.size !== role.permissions.length || role.permissions.some((p) => !selected.has(p));

  const byModule = React.useMemo(() => {
    const map = new Map<string, Permission[]>();
    for (const p of permissions) map.set(p.module, [...(map.get(p.module) ?? []), p]);
    return [...map.entries()];
  }, [permissions]);

  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const toggleModule = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const onSave = async () => {
    try {
      await save.mutateAsync({ id: role.id, permissions: [...selected] });
      toast.success('Permissions updated.');
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            {role.name}
            <Badge variant="outline" className="font-mono">
              {role.key}
            </Badge>
            {role.isSystem ? <Badge variant="secondary">system</Badge> : null}
          </CardTitle>
          <CardDescription>
            {role.description ?? 'No description'} - {selected.size} permissions - {role.userCount}{' '}
            users
          </CardDescription>
        </div>
        {editable ? (
          <Button
            size="sm"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => void onSave()}
          >
            <Save /> Save
          </Button>
        ) : locked ? (
          <Badge variant="secondary">
            <Lock className="mr-1 h-3 w-3" /> Fixed
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {byModule.map(([module, perms]) => {
          const keys = perms.map((p) => p.key);
          const all = keys.every((k) => selected.has(k));
          const some = keys.some((k) => selected.has(k));
          return (
            <div key={module}>
              <div className="mb-1.5 flex items-center gap-2">
                <Checkbox
                  id={`mod-${module}`}
                  checked={all ? true : some ? 'indeterminate' : false}
                  disabled={!editable}
                  onCheckedChange={(v) => toggleModule(keys, v === true)}
                />
                <Label
                  htmlFor={`mod-${module}`}
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {titleCase(module)}
                </Label>
              </div>
              <div className="grid gap-x-4 gap-y-1.5 pl-6 sm:grid-cols-2 xl:grid-cols-3">
                {perms.map((p) => (
                  <div key={p.key} className="flex items-start gap-2">
                    <Checkbox
                      id={p.key}
                      checked={selected.has(p.key)}
                      disabled={!editable}
                      onCheckedChange={(v) => toggle(p.key, v === true)}
                    />
                    <Label htmlFor={p.key} className="cursor-pointer leading-tight">
                      <code className="text-xs">{p.key}</code>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {p.description}
                      </span>
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
