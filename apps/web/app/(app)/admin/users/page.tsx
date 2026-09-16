'use client';
import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Search, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useSetUserStatus, useUsers } from '@/lib/api/hooks';
import type { UserView } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, ConfirmDialog, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { CreateUserDialog } from './create-user-dialog';
import { UserRolesDialog } from './user-roles-dialog';
import { toneOf } from '@/components/status';

const STATUS_VARIANT = { ACTIVE: 'success', INACTIVE: 'secondary', LOCKED: 'warning' } as const;

export default function UsersPage() {
  const { me, hasPermission } = useSession();
  const table = useTableState({ sortBy: 'createdAt', sortDir: 'desc' });
  const [status, setStatus] = React.useState<string>('ALL');
  const [createOpen, setCreateOpen] = React.useState(false);
  const [rolesFor, setRolesFor] = React.useState<UserView | null>(null);
  const [statusChange, setStatusChange] = React.useState<{
    user: UserView;
    to: 'ACTIVE' | 'INACTIVE';
  } | null>(null);

  const query = {
    ...table.query,
    status: status === 'ALL' ? undefined : (status as UserView['status']),
  };
  const users = useUsers(query);
  const setUserStatus = useSetUserStatus();

  const columns = React.useMemo<ColumnDef<UserView>[]>(
    () => [
      {
        accessorKey: 'lastName',
        header: 'Name',
        cell: ({ row }) => (
          <div>
            <div className="font-medium">
              {row.original.firstName} {row.original.lastName}
              {row.original.id === me.user.id ? (
                <span className="ml-2 text-xs text-muted-foreground">(you)</span>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">{row.original.email}</div>
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <StatusBadge tone={toneOf(STATUS_VARIANT[row.original.status])}>
            {row.original.status}
          </StatusBadge>
        ),
      },
      {
        accessorKey: 'lastLoginAt',
        header: 'Last login',
        enableSorting: false,
        cell: ({ row }) => formatDateTime(row.original.lastLoginAt),
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        cell: ({ row }) => formatDateTime(row.original.createdAt),
      },
      {
        id: 'actions',
        enableHiding: false,
        cell: ({ row }) => {
          const user = row.original;
          const canDeactivate = hasPermission(P['user.deactivate']) && user.id !== me.user.id;
          return (
            <div className="text-right">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Row actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setRolesFor(user)}>
                    <ShieldCheck /> Roles
                  </DropdownMenuItem>
                  {canDeactivate && user.status === 'ACTIVE' ? (
                    <DropdownMenuItem
                      onSelect={() => setStatusChange({ user, to: 'INACTIVE' })}
                      className="text-critical"
                    >
                      <UserX /> Deactivate
                    </DropdownMenuItem>
                  ) : null}
                  {canDeactivate && user.status !== 'ACTIVE' ? (
                    <DropdownMenuItem onSelect={() => setStatusChange({ user, to: 'ACTIVE' })}>
                      <UserCheck /> Activate
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      },
    ],
    [hasPermission, me.user.id],
  );

  return (
    <>
      <PageHeader
        title="Users"
        description="People who can sign in to this organization. Access is granted through roles."
        actions={
          <Can permissions={[P['user.create']]}>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New user
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={users.data}
        isLoading={users.isLoading}
        isFetching={users.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(u) => u.id}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Search name or email"
                className="w-64 pl-8"
              />
            </div>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
                <SelectItem value="LOCKED">Locked</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
        emptyState={
          <EmptyState
            title="No users match"
            description="Adjust the search or filters."
            className="border-0"
          />
        }
      />

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <UserRolesDialog user={rolesFor} onOpenChange={(open) => !open && setRolesFor(null)} />
      <ConfirmDialog
        open={Boolean(statusChange)}
        onOpenChange={(open) => !open && setStatusChange(null)}
        title={statusChange?.to === 'INACTIVE' ? 'Deactivate user?' : 'Activate user?'}
        description={
          statusChange?.to === 'INACTIVE'
            ? `${statusChange.user.email} will no longer be able to sign in. Their history is kept for audit purposes.`
            : `${statusChange?.user.email} will be able to sign in again.`
        }
        confirmLabel={statusChange?.to === 'INACTIVE' ? 'Deactivate' : 'Activate'}
        destructive={statusChange?.to === 'INACTIVE'}
        loading={setUserStatus.isPending}
        onConfirm={async () => {
          if (!statusChange) return;
          try {
            await setUserStatus.mutateAsync({ id: statusChange.user.id, status: statusChange.to });
            toast.success(`User ${statusChange.to === 'ACTIVE' ? 'activated' : 'deactivated'}.`);
            setStatusChange(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
