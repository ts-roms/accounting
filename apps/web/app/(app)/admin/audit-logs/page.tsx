'use client';
import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { Search } from 'lucide-react';
import { AUDIT_ACTIONS, type AuditAction } from '@accounting/types';
import {
  Badge,
  Dialog,
  SheetContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { useAuditLogs } from '@/lib/api/hooks';
import type { AuditLog } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { EmptyState, PageHeader } from '@/components/ui-ext/page';

const ACTION_VARIANT: Partial<
  Record<AuditAction, 'success' | 'destructive' | 'warning' | 'secondary'>
> = {
  CREATE: 'success',
  DELETE: 'destructive',
  DEACTIVATE: 'destructive',
  LOGIN_FAILED: 'warning',
  REJECT: 'warning',
  REVERSE: 'warning',
  VOID: 'destructive',
};

export default function AuditLogsPage() {
  return (
    <React.Suspense fallback={null}>
      <AuditLogsContent />
    </React.Suspense>
  );
}

function AuditLogsContent() {
  const params = useSearchParams();
  const table = useTableState({ pageSize: 25 });
  const [action, setAction] = React.useState<string>('ALL');
  const [entityType, setEntityType] = React.useState('');
  const [detail, setDetail] = React.useState<AuditLog | null>(null);
  const userId = params.get('userId') ?? undefined;

  const logs = useAuditLogs({
    page: table.query.page,
    pageSize: table.query.pageSize,
    search: table.query.search,
    action: action === 'ALL' ? undefined : (action as AuditAction),
    entityType: entityType || undefined,
    userId,
  });

  const columns = React.useMemo<ColumnDef<AuditLog>[]>(
    () => [
      {
        accessorKey: 'occurredAt',
        header: 'When',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{formatDateTime(row.original.occurredAt)}</span>
        ),
      },
      {
        accessorKey: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <Badge variant={ACTION_VARIANT[row.original.action] ?? 'secondary'}>
            {row.original.action}
          </Badge>
        ),
      },
      { accessorKey: 'module', header: 'Module' },
      {
        accessorKey: 'entityType',
        header: 'Entity',
        cell: ({ row }) => (
          <div>
            <div>{row.original.entityType}</div>
            <div className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
              {row.original.entityId ?? ''}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'userEmail',
        header: 'User',
        cell: ({ row }) =>
          row.original.userEmail ?? <span className="text-muted-foreground">system</span>,
      },
      {
        accessorKey: 'ipAddress',
        header: 'IP',
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.ipAddress ?? '-'}</span>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Audit Logs"
        description="Immutable record of every significant action. Entries cannot be edited or deleted, even by administrators."
      />
      <DataTable
        columns={columns}
        data={logs.data}
        isLoading={logs.isLoading}
        isFetching={logs.isFetching}
        pagination={table.pagination}
        getRowId={(l) => String(l.id)}
        onRowClick={setDetail}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="User, entity id, correlation id"
                className="w-72 pl-8"
              />
            </div>
            <Select
              value={action}
              onValueChange={(v) => {
                setAction(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All actions</SelectItem>
                {AUDIT_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={entityType}
              onChange={(e) => {
                setEntityType(e.target.value);
                table.resetPage();
              }}
              placeholder="Entity type (e.g. User)"
              className="w-44"
            />
            {userId ? <Badge variant="outline">Filtered by user</Badge> : null}
          </>
        }
        emptyState={
          <EmptyState
            title="No audit entries"
            description="Nothing matches the current filters."
            className="border-0"
          />
        }
      />

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent>
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Badge variant={ACTION_VARIANT[detail.action] ?? 'secondary'}>
                    {detail.action}
                  </Badge>
                  {detail.entityType}
                </DialogTitle>
                <DialogDescription>{formatDateTime(detail.occurredAt)}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-sm">
                <Field label="Module" value={detail.module} />
                <Field label="Entity ID" value={detail.entityId} mono />
                <Field label="User" value={detail.userEmail ?? 'system'} />
                <Field label="IP address" value={detail.ipAddress} mono />
                <Field label="Correlation" value={detail.correlationId} mono />
                <Field label="User agent" value={detail.userAgent} />
              </dl>
              <JsonBlock title="Previous value" value={detail.previousValue} />
              <JsonBlock title="New value" value={detail.newValue} />
              <JsonBlock title="Metadata" value={detail.metadata} />
            </>
          ) : null}
        </SheetContent>
      </Dialog>
    </>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-xs' : 'break-words'}>{value || '-'}</dd>
    </>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
