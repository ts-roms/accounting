'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  APPROVAL_REQUEST_STATUSES,
  P,
  PERMISSION_DEFINITIONS,
  WORKFLOW_DOCUMENT_TYPES,
  type ApprovalRequestStatus,
  type PermissionKey,
  type WorkflowDocumentType,
} from '@accounting/types';
import { createWorkflowSchema, type CreateWorkflowInput } from '@accounting/validation';
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormDescription,
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  StatusBadge,
  StepTimeline,
  type TimelineStep,
} from '@accounting/ui';
import { describeError, getActiveCompanyId } from '@/lib/api/client';
import { useBranches } from '@/lib/api/hooks';
import { DelegatedAuthorityNotice } from '@/components/delegations/delegated-authority-notice';
import {
  useApproval,
  useApprovals,
  useCreateWorkflow,
  useDecideApproval,
  useUpdateWorkflow,
  useWorkflows,
} from '@/lib/api/enterprise-hooks';
import type { ApprovalRequest, ApprovalWorkflow } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { ApprovalMatrix, ApproverPicker } from '@/components/enterprise/approval-matrix';
import { toneOf } from '@/components/status';

type WorkflowFormInput = z.input<typeof createWorkflowSchema>;

const DOCUMENT_PATH: Record<WorkflowDocumentType, string> = {
  JOURNAL_ENTRY: '/accounting/journal-entries',
  VENDOR_PAYMENT: '/purchasing/payments',
  PURCHASE_ORDER: '/purchasing/orders',
  EXPENSE_CLAIM: '/budgeting/expense-claims',
  VENDOR_BILL: '/purchasing/bills',
  SALES_ORDER: '/sales/orders',
  INVOICE: '/sales/invoices',
  CUSTOMER_PAYMENT: '/sales/payments',
  CUSTOMER_REFUND: '/receivables/refunds',
  WRITE_OFF: '/receivables/write-offs',
  PAYMENT_RUN: '/payables/payment-runs',
  VENDOR: '/purchasing/vendors',
  BANK_TRANSFER: '/treasury/transfers',
  PETTY_CASH_VOUCHER: '/treasury/petty-cash',
  CONSOLIDATION_RUN: '/consolidation/runs',
  PAY_RUN: '/payroll/runs',
  PAYMENT_FILE: '/treasury/payment-files',
};
const STATUS_VARIANT: Record<
  ApprovalRequestStatus,
  'warning' | 'success' | 'destructive' | 'outline'
> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'destructive',
  CANCELLED: 'outline',
};

export function WorkflowsPage() {
  const { hasPermission } = useSession();
  const workflows = useWorkflows();
  const update = useUpdateWorkflow();
  const [dialog, setDialog] = React.useState<{
    open: boolean;
    workflow?: ApprovalWorkflow;
    documentType?: WorkflowDocumentType;
  }>({ open: false });
  const [view, setView] = React.useState<'matrix' | 'list'>('matrix');
  const canManage = hasPermission(P['workflow.manage']);
  const workflowsById = React.useMemo(
    () => new Map((workflows.data ?? []).map((w) => [w.id, w])),
    [workflows.data],
  );
  return (
    <>
      <PageHeader
        title="Approval workflows"
        description="Per document type and amount band, the chain of approvals a document needs before it can be approved or posted - and who may decide each step. Requests snapshot the steps, so editing a workflow never changes an open chain."
        actions={
          <div className="flex items-center gap-2">
            <Tabs value={view} onValueChange={(v) => setView(v as 'matrix' | 'list')}>
              <TabsList>
                <TabsTrigger value="matrix" data-testid="workflows-view-matrix">
                  Matrix
                </TabsTrigger>
                <TabsTrigger value="list" data-testid="workflows-view-list">
                  Workflows
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Can permissions={[P['workflow.manage']]}>
              <Button onClick={() => setDialog({ open: true })} data-testid="new-workflow">
                <Plus /> New workflow
              </Button>
            </Can>
          </div>
        }
      />
      {view === 'matrix' ? (
        <ApprovalMatrix
          workflowsById={workflowsById}
          onEdit={(workflow) => setDialog({ open: true, workflow })}
          onAdd={(documentType) => setDialog({ open: true, documentType })}
        />
      ) : workflows.isLoading ? (
        <TableSkeleton columns={6} />
      ) : workflows.data?.length === 0 ? (
        <EmptyState
          title="No workflows"
          description="Without a workflow, documents follow the plain approve / post permissions."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Document</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Amount band</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage ? <TableHead className="w-32" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.data?.map((w) => (
                  <TableRow key={w.id} data-testid="workflow-row">
                    <TableCell>{titleCase(w.documentType)}</TableCell>
                    <TableCell>
                      <div className="font-medium">{w.name}</div>
                      {w.description ? (
                        <div className="text-xs text-muted-foreground">{w.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs tabular">
                      ≥ {w.minAmount}
                      {w.maxAmount ? ` and < ${w.maxAmount}` : ''} · priority {w.priority}
                    </TableCell>
                    <TableCell className="text-xs">
                      {w.steps.map((s, i) => (
                        <div key={i}>
                          {i + 1}. {s.name}{' '}
                          <span className="text-muted-foreground">
                            ({s.requiredPermission}
                            {s.minApprovers > 1 ? ` ×${s.minApprovers}` : ''})
                          </span>
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="text-right tabular">{w.openRequests}</TableCell>
                    <TableCell>
                      <StatusBadge tone={toneOf(w.status === 'ACTIVE' ? 'success' : 'secondary')}>
                        {w.status}
                      </StatusBadge>
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDialog({ open: true, workflow: w })}
                        >
                          <Pencil /> Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              await update.mutateAsync({
                                id: w.id,
                                status: w.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                              });
                            } catch (err) {
                              toast.error(describeError(err));
                            }
                          }}
                        >
                          {w.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <WorkflowDialog
        open={dialog.open}
        workflow={dialog.workflow}
        documentType={dialog.documentType}
        onOpenChange={(open) => setDialog({ open })}
      />
    </>
  );
}

function WorkflowDialog({
  open,
  workflow,
  documentType,
  onOpenChange,
}: {
  open: boolean;
  workflow?: ApprovalWorkflow;
  /** Preset for a new workflow opened from a matrix row. */
  documentType?: WorkflowDocumentType;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateWorkflow();
  const update = useUpdateWorkflow();
  const defaults = React.useCallback(
    (): WorkflowFormInput => ({
      documentType: workflow?.documentType ?? documentType ?? 'JOURNAL_ENTRY',
      name: workflow?.name ?? '',
      description: workflow?.description ?? undefined,
      minAmount: workflow?.minAmount ?? '0',
      maxAmount: workflow?.maxAmount ?? null,
      priority: workflow?.priority ?? 100,
      allowSelfApproval: workflow?.allowSelfApproval ?? false,
      branchId: workflow?.branchId ?? null,
      deadlineHours: workflow?.deadlineHours ?? null,
      escalationPermission: workflow?.escalationPermission ?? null,
      steps: workflow?.steps.map((s) => ({
        ...s,
        approverUserIds: s.approverUserIds ?? [],
        approverRoleIds: s.approverRoleIds ?? [],
      })) ?? [
        {
          name: 'Finance review',
          requiredPermission: 'journal.approve',
          minApprovers: 1,
          approverUserIds: [],
          approverRoleIds: [],
        },
      ],
    }),
    [workflow, documentType],
  );
  const form = useForm<WorkflowFormInput, unknown, CreateWorkflowInput>({
    resolver: zodResolver(createWorkflowSchema),
    defaultValues: defaults(),
  });
  const steps = useFieldArray({ control: form.control, name: 'steps' });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const submit = form.handleSubmit(async (values) => {
    try {
      if (workflow) {
        const { documentType: _d, ...rest } = values;
        await update.mutateAsync({ id: workflow.id, ...rest });
      } else await create.mutateAsync(values);
      toast.success(workflow ? 'Workflow updated.' : 'Workflow created.');
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  const permissionOptions = PERMISSION_DEFINITIONS.map((p) => p.key).sort();
  const branches = useBranches(getActiveCompanyId() ?? undefined);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{workflow ? `Edit ${workflow.name}` : 'New approval workflow'}</DialogTitle>
          <DialogDescription>
            Each step names the permission an approver must hold and, optionally, the users or roles
            allowed to decide it (the approval matrix); one person decides at most once per request.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="documentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Document type</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={Boolean(workflow)}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="wf-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {WORKFLOW_DOCUMENT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {titleCase(t)}
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
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="wf-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="minAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Applies from amount</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        className="text-right tabular"
                        {...field}
                        value={String(field.value ?? '')}
                        data-testid="wf-min"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="maxAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Up to (exclusive)</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        className="text-right tabular"
                        {...field}
                        value={field.value ?? ''}
                        placeholder="No upper bound"
                        onChange={(e) => field.onChange(e.target.value || null)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} {...field} value={String(field.value ?? '')} />
                    </FormControl>
                    <FormDescription>Lower wins when bands overlap.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="allowSelfApproval"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 pt-7">
                    <FormControl>
                      <Checkbox
                        checked={Boolean(field.value)}
                        onCheckedChange={(v) => field.onChange(Boolean(v))}
                      />
                    </FormControl>
                    <FormLabel className="!mt-0">
                      Requester may approve their own document
                    </FormLabel>
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="branchId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Branch</FormLabel>
                    <Select
                      value={field.value ?? '__all__'}
                      onValueChange={(v) => field.onChange(v === '__all__' ? null : v)}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="workflow-branch">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__all__">Every branch</SelectItem>
                        {(branches.data ?? []).map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.code} {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>A branch workflow beats a company-wide one.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="deadlineHours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Deadline (hours)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        value={
                          field.value === null || field.value === undefined
                            ? ''
                            : String(field.value)
                        }
                        placeholder="No deadline"
                        onChange={(e) =>
                          field.onChange(e.target.value === '' ? null : e.target.value)
                        }
                        data-testid="workflow-deadline"
                      />
                    </FormControl>
                    <FormDescription>Requests past it are overdue and escalate.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="escalationPermission"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Escalate to</FormLabel>
                    <Select
                      value={field.value ?? '__none__'}
                      onValueChange={(v) => field.onChange(v === '__none__' ? null : v)}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="workflow-escalation">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">Nobody</SelectItem>
                        {permissionOptions.map((p) => (
                          <SelectItem key={p} value={p} className="font-mono text-xs">
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>Holders may decide an overdue request.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Steps</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    steps.append({
                      name: '',
                      requiredPermission: 'journal.approve',
                      minApprovers: 1,
                      approverUserIds: [],
                      approverRoleIds: [],
                    })
                  }
                >
                  <Plus /> Add step
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Required permission</TableHead>
                    <TableHead className="w-24">Approvers</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {steps.fields.map((f, i) => (
                    <TableRow key={f.id} className="hover:bg-transparent">
                      <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`steps.${i}.name`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input {...field} data-testid="wf-step-name" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`steps.${i}.requiredPermission`}
                          render={({ field }) => (
                            <FormItem>
                              <Select value={field.value} onValueChange={field.onChange}>
                                <FormControl>
                                  <SelectTrigger className="font-mono text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {permissionOptions.map((p) => (
                                    <SelectItem key={p} value={p} className="font-mono text-xs">
                                      {p}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`steps.${i}.minApprovers`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  type="number"
                                  min={1}
                                  max={10}
                                  {...field}
                                  value={String(field.value ?? 1)}
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove step"
                          disabled={steps.fields.length <= 1}
                          onClick={() => steps.remove(i)}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {steps.fields.map((f, i) => (
                    <TableRow key={`${f.id}-approvers`} className="hover:bg-transparent">
                      <TableCell />
                      <TableCell colSpan={4} className="pt-0">
                        <FormField
                          control={form.control}
                          name={`steps.${i}.approverUserIds`}
                          render={({ field: usersField }) => (
                            <FormField
                              control={form.control}
                              name={`steps.${i}.approverRoleIds`}
                              render={({ field: rolesField }) => (
                                <FormItem>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <FormLabel className="text-xs text-muted-foreground">
                                      Step {i + 1} approvers
                                    </FormLabel>
                                    <ApproverPicker
                                      userIds={usersField.value ?? []}
                                      roleIds={rolesField.value ?? []}
                                      onChange={(next) => {
                                        usersField.onChange(next.userIds);
                                        rolesField.onChange(next.roleIds);
                                      }}
                                    />
                                  </div>
                                </FormItem>
                              )}
                            />
                          )}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || update.isPending}
                data-testid="wf-save"
              >
                {workflow ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ inbox

export function ApprovalsPage() {
  const table = useTableState();
  const [scope, setScope] = React.useState<'mine' | 'all'>('mine');
  const [status, setStatus] = React.useState('ALL');
  const [selected, setSelected] = React.useState<string | null>(null);
  const requests = useApprovals({
    ...table.query,
    mine: scope === 'mine' ? true : undefined,
    status: scope === 'mine' || status === 'ALL' ? undefined : (status as ApprovalRequestStatus),
  });
  const columns = React.useMemo<ColumnDef<ApprovalRequest>[]>(
    () => [
      {
        id: 'document',
        header: 'Document',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`${DOCUMENT_PATH[row.original.documentType]}/${row.original.documentId}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.documentNumber}
          </Link>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.documentType),
      },
      {
        id: 'workflow',
        header: 'Workflow · step',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.workflowName} ·{' '}
            {row.original.status === 'PENDING'
              ? `${row.original.steps[row.original.currentStep]?.name ?? '-'} (${row.original.currentStep + 1}/${row.original.steps.length})`
              : titleCase(row.original.status)}
            {row.original.overdue ? (
              <StatusBadge tone="warning" className="ml-2" data-testid="approval-overdue">
                Overdue
              </StatusBadge>
            ) : row.original.dueAt && row.original.status === 'PENDING' ? (
              <div className="text-muted-foreground">due {formatDateTime(row.original.dueAt)}</div>
            ) : null}
          </span>
        ),
      },
      {
        id: 'requester',
        header: 'Requested by',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.requestedByName ?? '-'}
            <div className="text-muted-foreground">{formatDateTime(row.original.createdAt)}</div>
          </span>
        ),
      },
      {
        id: 'amount',
        header: () => <div className="text-right">Amount</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.amount} currency={row.original.currency} />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <StatusBadge tone={toneOf(STATUS_VARIANT[row.original.status])}>
            {titleCase(row.original.status)}
          </StatusBadge>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Requests raised by approval workflows. Your inbox lists only the steps you can decide right now."
      />
      <DataTable
        columns={columns}
        data={requests.data}
        isLoading={requests.isLoading}
        isFetching={requests.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => setSelected(r.id)}
        toolbar={
          <>
            <Tabs
              value={scope}
              onValueChange={(v) => {
                setScope(v as 'mine' | 'all');
                table.resetPage();
              }}
            >
              <TabsList>
                <TabsTrigger value="mine" data-testid="approvals-mine">
                  My inbox
                </TabsTrigger>
                <TabsTrigger value="all">All requests</TabsTrigger>
              </TabsList>
            </Tabs>
            {scope === 'all' ? (
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
                  {APPROVAL_REQUEST_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </>
        }
      />
      <ApprovalDialog id={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

export function ApprovalDialog({
  id,
  onOpenChange,
}: {
  id: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const request = useApproval(id);
  const decide = useDecideApproval();
  const [comment, setComment] = React.useState('');
  React.useEffect(() => setComment(''), [id]);
  const r = request.data;
  const run = async (decision: 'APPROVE' | 'REJECT') => {
    if (!r) return;
    try {
      const result = await decide.mutateAsync({
        id: r.id,
        decision,
        comment: comment.trim() || undefined,
      });
      toast.success(
        result.status === 'APPROVED'
          ? `${r.documentNumber} fully approved.`
          : result.status === 'REJECTED'
            ? `${r.documentNumber} rejected.`
            : `Step approved; ${result.pendingApprovals} more approval(s) needed on step ${result.currentStep + 1}.`,
      );
      setComment('');
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={Boolean(id)} onOpenChange={onOpenChange}>
      <DialogContent>
        {!r ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Link
                  href={`${DOCUMENT_PATH[r.documentType]}/${r.documentId}`}
                  className="font-mono hover:underline"
                >
                  {r.documentNumber}
                </Link>
                <StatusBadge tone={toneOf(STATUS_VARIANT[r.status])}>
                  {titleCase(r.status)}
                </StatusBadge>
              </DialogTitle>
              <DialogDescription>
                {titleCase(r.documentType)} · {r.amount} {r.currency} · {r.workflowName} · requested
                by {r.requestedByName ?? '-'} {formatDateTime(r.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <StepTimeline
              animate
              steps={[
                {
                  key: 'created',
                  label: 'Submitted',
                  state: 'complete',
                  meta: `${formatDateTime(r.createdAt)}${r.requestedByName ? ` · ${r.requestedByName}` : ''}`,
                },
                ...r.steps.map((s, i): TimelineStep => {
                  const decisions = r.decisions.filter((d) => d.step === i);
                  const rejected = decisions.some((d) => d.decision === 'REJECT');
                  const state: TimelineStep['state'] = rejected
                    ? 'failed'
                    : i < r.currentStep || r.status === 'APPROVED'
                      ? 'complete'
                      : i === r.currentStep && r.status === 'PENDING'
                        ? 'current'
                        : r.status === 'CANCELLED'
                          ? 'skipped'
                          : 'upcoming';
                  return {
                    key: `step-${i}`,
                    label: (
                      <span data-testid="approval-step" data-state={state}>
                        {s.name}{' '}
                        <span className="font-mono text-xs font-normal text-muted-foreground">
                          {s.requiredPermission}
                        </span>
                      </span>
                    ),
                    state,
                    meta:
                      decisions.length > 0
                        ? decisions
                            .map(
                              (d) =>
                                `${d.decision === 'APPROVE' ? 'Approved' : 'Rejected'} by ${d.decidedByName ?? d.decidedBy} · ${formatDateTime(d.decidedAt)}${d.comment ? ` · ${d.comment}` : ''}`,
                            )
                            .join(' / ')
                        : s.minApprovers > 1
                          ? `${s.minApprovers} approvers required`
                          : undefined,
                  };
                }),
                {
                  key: 'done',
                  label:
                    r.status === 'REJECTED'
                      ? 'Rejected'
                      : r.status === 'CANCELLED'
                        ? 'Cancelled'
                        : 'Approved',
                  state:
                    r.status === 'APPROVED'
                      ? 'complete'
                      : r.status === 'REJECTED'
                        ? 'failed'
                        : r.status === 'CANCELLED'
                          ? 'skipped'
                          : 'upcoming',
                },
              ]}
            />
            {r.canDecide && r.steps[r.currentStep] ? (
              <DelegatedAuthorityNotice
                permission={r.steps[r.currentStep]!.requiredPermission as PermissionKey}
                amount={r.amount}
                currency={r.currency}
              />
            ) : null}
            {r.canDecide ? (
              <div className="space-y-1">
                <Label>Comment</Label>
                <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
            ) : r.status === 'PENDING' ? (
              <p className="text-xs text-muted-foreground">
                You cannot decide this step (wrong permission, you requested it, or you already
                decided).
              </p>
            ) : null}
            <DialogFooter>
              {r.canDecide ? (
                <>
                  <Button
                    variant="outline"
                    disabled={decide.isPending}
                    onClick={() => run('REJECT')}
                    data-testid="approval-reject"
                  >
                    <X /> Reject
                  </Button>
                  <Button
                    disabled={decide.isPending}
                    onClick={() => run('APPROVE')}
                    data-testid="approval-approve"
                  >
                    <Check /> Approve
                  </Button>
                </>
              ) : null}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
