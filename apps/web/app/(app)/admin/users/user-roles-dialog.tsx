'use client';
import * as React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAssignRole,
  useCompanies,
  useRevokeRole,
  useRoles,
  useUserRoles,
} from '@/lib/api/hooks';
import type { SodConflict, UserView } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can } from '@/components/ui-ext/page';

const ORG_WIDE = '__org__';

/** Assign / revoke role assignments, surfacing segregation-of-duties warnings. */
export function UserRolesDialog({
  user,
  onOpenChange,
}: {
  user: UserView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { hasPermission } = useSession();
  const assignments = useUserRoles(user?.id ?? null);
  const roles = useRoles();
  const companies = useCompanies();
  const assign = useAssignRole();
  const revoke = useRevokeRole();
  const [roleId, setRoleId] = React.useState('');
  const [scope, setScope] = React.useState(ORG_WIDE);
  const [warnings, setWarnings] = React.useState<SodConflict[]>([]);

  React.useEffect(() => {
    setWarnings([]);
    setRoleId('');
    setScope(ORG_WIDE);
  }, [user?.id]);

  const onAssign = async () => {
    if (!user || !roleId) return;
    try {
      const result = await assign.mutateAsync({
        userId: user.id,
        roleId,
        companyId: scope === ORG_WIDE ? null : scope,
      });
      setWarnings(result.warnings);
      toast.success(
        result.warnings.length
          ? 'Role assigned with segregation-of-duties warnings.'
          : 'Role assigned.',
      );
      setRoleId('');
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  const onRevoke = async (assignmentId: string) => {
    if (!user) return;
    try {
      await revoke.mutateAsync({ userId: user.id, assignmentId });
      toast.success('Role revoked.');
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Dialog open={Boolean(user)} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Roles for {user ? `${user.firstName} ${user.lastName}` : ''}</DialogTitle>
          <DialogDescription>
            Organization-wide assignments apply to every company. Company-scoped assignments only
            grant permissions when that company is active.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {assignments.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : assignments.data?.length ? (
            assignments.data.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium">{a.roleName}</span>{' '}
                  <span className="font-mono text-xs text-muted-foreground">{a.roleKey}</span>
                  <div className="text-xs text-muted-foreground">
                    {a.companyName ? `Company: ${a.companyName}` : 'Organization-wide'}
                  </div>
                </div>
                <Can permissions={[P['role.assign']]}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Revoke role"
                    onClick={() => void onRevoke(a.id)}
                    disabled={revoke.isPending}
                  >
                    <Trash2 />
                  </Button>
                </Can>
              </div>
            ))
          ) : (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              No roles assigned. This user cannot access any module.
            </p>
          )}
        </div>

        {warnings.length > 0 ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>Segregation-of-duties warnings</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {warnings.map((w) => (
                  <li key={w.policyId}>
                    {w.policyName}: <code className="text-xs">{w.permissionA}</code> +{' '}
                    <code className="text-xs">{w.permissionB}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">
                The assignment was recorded together with these warnings in the audit trail.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {hasPermission(P['role.assign']) ? (
          <>
            <Separator />
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {(roles.data ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}{' '}
                      {r.isSystem ? (
                        <Badge variant="outline" className="ml-1">
                          system
                        </Badge>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ORG_WIDE}>Organization-wide</SelectItem>
                  {(companies.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} - {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => void onAssign()} disabled={!roleId} loading={assign.isPending}>
                Assign
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
