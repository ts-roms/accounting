'use client';
import * as React from 'react';
import { ChevronDown, Pencil, Plus, ShieldCheck, User, Users } from 'lucide-react';
import { P, type WorkflowDocumentType } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useApprovalMatrix, useApproverOptions } from '@/lib/api/enterprise-hooks';
import type { ApprovalWorkflow, MatrixApprover, MatrixWorkflow } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { EmptyState } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { toneOf } from '@/components/status';

/**
 * Approval matrix: one row per document type, one cell per amount band, each
 * listing the steps and who decides them (named users / roles, or "anyone
 * with <permission>"). Read from `GET /approval-workflows/matrix`; editing
 * goes through the same workflow dialog as the list view.
 */
export function ApprovalMatrix({
  onEdit,
  onAdd,
  workflowsById,
}: {
  onEdit: (workflow: ApprovalWorkflow) => void;
  onAdd: (documentType: WorkflowDocumentType) => void;
  workflowsById: ReadonlyMap<string, ApprovalWorkflow>;
}) {
  const { hasPermission } = useSession();
  const canManage = hasPermission(P['workflow.manage']);
  const matrix = useApprovalMatrix();
  if (matrix.isLoading) return <Skeleton className="h-64" />;
  const rows = matrix.data ?? [];
  const configured = rows.filter((r) => r.workflows.length > 0).length;
  if (configured === 0)
    return (
      <EmptyState
        title="No approval matrix yet"
        description="Add a workflow to a document type to decide who approves what, by amount band."
        action={
          canManage ? (
            <Button onClick={() => onAdd('JOURNAL_ENTRY')} data-testid="matrix-add-first">
              <Plus /> Add workflow
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table data-testid="approval-matrix">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-48">Document</TableHead>
                <TableHead>Amount bands → steps → approvers</TableHead>
                {canManage ? <TableHead className="w-28" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.documentType}
                  className="align-top"
                  data-testid="matrix-row"
                  data-document-type={row.documentType}
                >
                  <TableCell className="font-medium">
                    {titleCase(row.documentType)}
                    {row.workflows.length === 0 ? (
                      <div className="text-xs text-muted-foreground">
                        No workflow: plain approve / post permission.
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {row.workflows.map((w) => (
                        <BandCell
                          key={w.id}
                          workflow={w}
                          onEdit={
                            canManage && workflowsById.get(w.id)
                              ? () => onEdit(workflowsById.get(w.id)!)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  </TableCell>
                  {canManage ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onAdd(row.documentType)}
                        data-testid="matrix-add-band"
                      >
                        <Plus /> Band
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function BandCell({ workflow: w, onEdit }: { workflow: MatrixWorkflow; onEdit?: () => void }) {
  return (
    <div
      className="min-w-56 flex-1 rounded-md border border-border/70 bg-card p-2 text-xs"
      data-testid="matrix-band"
      data-status={w.status}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{w.name}</div>
          <div className="tabular text-muted-foreground">
            ≥ <Amount value={w.minAmount} className="inline text-left" />
            {w.maxAmount ? (
              <>
                {' and < '}
                <Amount value={w.maxAmount} className="inline text-left" />
              </>
            ) : (
              ' and up'
            )}
            {w.branchId ? ' · branch-scoped' : ''}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {w.status !== 'ACTIVE' ? (
            <StatusBadge tone={toneOf('secondary')} size="sm">
              Inactive
            </StatusBadge>
          ) : null}
          {w.openRequests > 0 ? (
            <StatusBadge tone="warning" size="sm">
              {w.openRequests} open
            </StatusBadge>
          ) : null}
          {onEdit ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${w.name}`}
              onClick={onEdit}
              data-testid="matrix-edit"
            >
              <Pencil />
            </Button>
          ) : null}
        </div>
      </div>
      <ol className="mt-2 space-y-1.5">
        {w.steps.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">
              {i + 1}. {s.name}
              {s.minApprovers > 1 ? ` ×${s.minApprovers}` : ''}
            </span>
            {s.approvers.length === 0 ? (
              <ApproverChip
                approver={{
                  kind: 'ROLE',
                  id: s.requiredPermission,
                  name: `anyone with ${s.requiredPermission}`,
                }}
                permission
              />
            ) : (
              s.approvers.map((a) => <ApproverChip key={`${a.kind}-${a.id}`} approver={a} />)
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ApproverChip({
  approver,
  permission = false,
}: {
  approver: MatrixApprover;
  permission?: boolean;
}) {
  const Icon = permission ? ShieldCheck : approver.kind === 'USER' ? User : Users;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-1.5 py-0.5"
      data-testid="matrix-approver"
      data-kind={permission ? 'PERMISSION' : approver.kind}
    >
      <Icon className="size-3 text-subtle-foreground" aria-hidden />
      <span className={permission ? 'font-mono' : undefined}>{approver.name}</span>
    </span>
  );
}

/**
 * Multi-select of named approvers for one workflow step: users and roles of
 * the organization (`GET /approval-workflows/approver-options`).
 */
export function ApproverPicker({
  userIds,
  roleIds,
  onChange,
}: {
  userIds: string[];
  roleIds: string[];
  onChange: (next: { userIds: string[]; roleIds: string[] }) => void;
}) {
  const options = useApproverOptions();
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const userName = (id: string) => options.data?.users.find((u) => u.id === id)?.name ?? '…';
  const roleName = (id: string) => options.data?.roles.find((r) => r.id === id)?.name ?? '…';
  const count = userIds.length + roleIds.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" data-testid="wf-step-approvers">
            {count === 0 ? 'Anyone with the permission' : `${count} named`}
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
          <DropdownMenuLabel>Roles</DropdownMenuLabel>
          {options.data?.roles.map((r) => (
            <DropdownMenuCheckboxItem
              key={r.id}
              checked={roleIds.includes(r.id)}
              onCheckedChange={() => onChange({ userIds, roleIds: toggle(roleIds, r.id) })}
              onSelect={(e) => e.preventDefault()}
              data-testid="wf-approver-role"
            >
              {r.name}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Users</DropdownMenuLabel>
          {options.data?.users.map((u) => (
            <DropdownMenuCheckboxItem
              key={u.id}
              checked={userIds.includes(u.id)}
              onCheckedChange={() => onChange({ userIds: toggle(userIds, u.id), roleIds })}
              onSelect={(e) => e.preventDefault()}
              data-testid="wf-approver-user"
            >
              <span className="truncate">{u.name}</span>
              <span className="ml-1 truncate text-xs text-muted-foreground">{u.email}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {options.isLoading ? <Skeleton className="m-2 h-16" /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {roleIds.map((id) => (
        <ApproverChip key={id} approver={{ kind: 'ROLE', id, name: roleName(id) }} />
      ))}
      {userIds.map((id) => (
        <ApproverChip key={id} approver={{ kind: 'USER', id, name: userName(id) }} />
      ))}
    </div>
  );
}
