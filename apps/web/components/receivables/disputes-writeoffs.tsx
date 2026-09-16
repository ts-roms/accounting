'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, FileX, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  DISPUTE_REASONS,
  DISPUTE_RESOLUTIONS,
  DISPUTE_STATUSES,
  P,
  WRITE_OFF_REASONS,
  WRITE_OFF_STATUSES,
} from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateDispute,
  useCreateProvision,
  useCreateWriteOff,
  useDisputes,
  useProvisionAction,
  useProvisions,
  useUpdateDispute,
  useWriteOffAction,
  useWriteOffs,
} from '@/lib/api/receivables-hooks';
import type { Dispute, WriteOff } from '@/lib/api/receivables-types';
import { useDocuments } from '@/lib/api/subledger-hooks';
import { AR_CONFIG } from '@/lib/subledger/config';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { Field, ReasonDialog, StatusBadge } from './shared';

// ---------------------------------------------------------------- disputes

export function DisputesPage() {
  const { hasPermission } = useSession();
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('OPEN');
  const [create, setCreate] = React.useState(false);
  const [editing, setEditing] = React.useState<Dispute | null>(null);
  const disputes = useDisputes({
    ...table.query,
    openOnly: status === 'OPEN' || undefined,
    status: status === 'OPEN' || status === 'ALL' ? undefined : (status as Dispute['status']),
  });
  const columns = React.useMemo<ColumnDef<Dispute>[]>(
    () => [
      {
        id: 'number',
        header: 'Dispute',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.documentNumber}</span>,
      },
      {
        id: 'invoice',
        header: 'Invoice',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`${AR_CONFIG.document.path}/${row.original.invoiceId}`}
            className="font-mono text-xs hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.invoiceNumber}
          </Link>
        ),
      },
      {
        id: 'customer',
        header: 'Customer',
        enableSorting: false,
        cell: ({ row }) => <div className="max-w-xs truncate">{row.original.customerName}</div>,
      },
      {
        id: 'reason',
        header: 'Reason',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.reason),
      },
      {
        id: 'amount',
        header: () => <div className="text-right">Disputed</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.amount} />,
      },
      {
        id: 'assignee',
        header: 'Assignee',
        enableSorting: false,
        cell: ({ row }) => row.original.assigneeName ?? '-',
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Disputes"
        description="Customer challenges on posted invoices. An open dispute flags the invoice, pauses dunning and blocks write-off until it is resolved."
        actions={
          <Can permissions={[P['dispute.manage']]}>
            <Button onClick={() => setCreate(true)}>
              <Plus /> Open dispute
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={disputes.data}
        isLoading={disputes.isLoading}
        isFetching={disputes.isFetching}
        pagination={table.pagination}
        getRowId={(d) => d.id}
        onRowClick={(d) => (hasPermission(P['dispute.manage']) ? setEditing(d) : undefined)}
        emptyState={<EmptyState icon={AlertTriangle} title="No disputes" />}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Dispute, invoice, customer"
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
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="ALL">All</SelectItem>
                {DISPUTE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <NewDisputeDialog open={create} onOpenChange={setCreate} />
      {editing ? (
        <DisputeDialog dispute={editing} onOpenChange={(o) => !o && setEditing(null)} />
      ) : null}
    </>
  );
}

export function NewDisputeDialog({
  open,
  onOpenChange,
  invoiceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoiceId?: string;
}) {
  const create = useCreateDispute();
  const invoices = useDocuments(
    AR_CONFIG,
    { openOnly: true, pageSize: 100, documentType: 'INVOICE' },
    open && !invoiceId,
  );
  const [inv, setInv] = React.useState(invoiceId ?? '');
  const [reason, setReason] = React.useState<(typeof DISPUTE_REASONS)[number]>('INCORRECT_PRICE');
  const [amount, setAmount] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [raisedBy, setRaisedBy] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a dispute</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!invoiceId ? (
            <Field label="Invoice">
              <Select value={inv} onValueChange={setInv}>
                <SelectTrigger>
                  <SelectValue placeholder="Open invoice" />
                </SelectTrigger>
                <SelectContent>
                  {invoices.data?.items.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.documentNumber} - {i.customerName} ({i.balance})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Reason">
              <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISPUTE_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {titleCase(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Disputed amount" hint="Blank = whole open balance">
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Raised by">
            <Input
              value={raisedBy}
              onChange={(e) => setRaisedBy(e.target.value)}
              placeholder="Customer contact"
            />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!inv || !description.trim() || create.isPending}
            onClick={async () => {
              try {
                await create.mutateAsync({
                  invoiceId: inv,
                  reason,
                  amount: amount || undefined,
                  description,
                  raisedBy: raisedBy || undefined,
                });
                toast.success('Dispute opened.');
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Open dispute
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisputeDialog({
  dispute,
  onOpenChange,
}: {
  dispute: Dispute;
  onOpenChange: (o: boolean) => void;
}) {
  const update = useUpdateDispute();
  const [status, setStatus] = React.useState<Dispute['status']>(dispute.status);
  const [resolution, setResolution] = React.useState<string>(dispute.resolution ?? 'none');
  const [notes, setNotes] = React.useState(dispute.resolutionNotes ?? '');
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {dispute.documentNumber} - {dispute.invoiceNumber}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {titleCase(dispute.reason)}: {dispute.description}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as Dispute['status'])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISPUTE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Resolution">
            <Select value={resolution} onValueChange={setResolution}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not decided</SelectItem>
                {DISPUTE_RESOLUTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {titleCase(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field
          label="Resolution notes"
          hint="Credit resolutions need a posted credit note - raise it from the invoices screen and link it via the API."
        >
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            disabled={update.isPending}
            onClick={async () => {
              try {
                await update.mutateAsync({
                  id: dispute.id,
                  status: status !== dispute.status ? status : undefined,
                  resolution: resolution === 'none' ? null : (resolution as Dispute['resolution']),
                  resolutionNotes: notes || undefined,
                });
                toast.success('Dispute updated.');
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------- write-offs

export function WriteOffsPage() {
  const { hasPermission } = useSession();
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [create, setCreate] = React.useState(false);
  const [decision, setDecision] = React.useState<{
    wo: WriteOff;
    action: 'approve' | 'reject' | 'recover';
  } | null>(null);
  const writeOffs = useWriteOffs({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as WriteOff['status']),
  });
  const act = useWriteOffAction();
  const run = async (wo: WriteOff, action: 'submit' | 'post') => {
    try {
      await act.mutateAsync({
        id: wo.id,
        action,
        writeOffDate: action === 'post' ? today() : undefined,
      });
      toast.success(`${wo.documentNumber} ${action === 'post' ? 'posted' : 'submitted'}.`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const columns = React.useMemo<ColumnDef<WriteOff>[]>(
    () => [
      {
        id: 'number',
        header: 'Write-off',
        enableSorting: false,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.documentNumber}</span>,
      },
      {
        id: 'invoice',
        header: 'Invoice',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`${AR_CONFIG.document.path}/${row.original.invoiceId}`}
            className="font-mono text-xs hover:underline"
          >
            {row.original.invoiceNumber}
          </Link>
        ),
      },
      {
        id: 'customer',
        header: 'Customer',
        enableSorting: false,
        cell: ({ row }) => <div className="max-w-xs truncate">{row.original.customerName}</div>,
      },
      {
        id: 'reason',
        header: 'Reason',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div>{titleCase(row.original.reason)}</div>
            <div className="max-w-xs truncate text-xs text-muted-foreground">
              {row.original.justification}
            </div>
          </div>
        ),
      },
      {
        id: 'amount',
        header: () => <div className="text-right">Amount</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.amount} currency={row.original.currency} />,
      },
      {
        id: 'journal',
        header: 'Journal',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.journalNumber ? (
            <Link
              href={`/accounting/journal-entries/${row.original.journalEntryId}`}
              className="font-mono text-xs hover:underline"
            >
              {row.original.journalNumber}
            </Link>
          ) : (
            '-'
          ),
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => {
          const wo = row.original;
          return (
            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              {wo.status === 'DRAFT' && hasPermission(P['write-off.create']) ? (
                <Button size="sm" variant="outline" onClick={() => run(wo, 'submit')}>
                  Submit
                </Button>
              ) : null}
              {(wo.status === 'DRAFT' || wo.status === 'SUBMITTED') &&
              hasPermission(P['write-off.approve']) ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDecision({ wo, action: 'approve' })}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDecision({ wo, action: 'reject' })}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {wo.status === 'APPROVED' && hasPermission(P['write-off.post']) ? (
                <Button size="sm" onClick={() => run(wo, 'post')}>
                  Post
                </Button>
              ) : null}
              {wo.status === 'POSTED' && hasPermission(P['write-off.post']) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDecision({ wo, action: 'recover' })}
                >
                  Recover
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasPermission],
  );
  return (
    <>
      <PageHeader
        title="Write-Offs"
        description="Controlled removal of receivable balances: permission, approval, reason and a journal through the posting gateway. Recoveries reinstate the balance."
        actions={
          <Can permissions={[P['write-off.create']]}>
            <Button onClick={() => setCreate(true)}>
              <Plus /> Request write-off
            </Button>
          </Can>
        }
      />
      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">Write-off requests</TabsTrigger>
          <TabsTrigger value="provisions">Bad-debt provisions</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <DataTable
            columns={columns}
            data={writeOffs.data}
            isLoading={writeOffs.isLoading}
            isFetching={writeOffs.isFetching}
            pagination={table.pagination}
            getRowId={(d) => d.id}
            emptyState={<EmptyState icon={FileX} title="No write-off requests" />}
            toolbar={
              <>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={table.search}
                    onChange={(e) => table.setSearch(e.target.value)}
                    placeholder="Write-off, invoice, customer"
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
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All statuses</SelectItem>
                    {WRITE_OFF_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {titleCase(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            }
          />
        </TabsContent>
        <TabsContent value="provisions">
          <ProvisionsPanel />
        </TabsContent>
      </Tabs>
      <NewWriteOffDialog open={create} onOpenChange={setCreate} />
      {decision ? (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDecision(null)}
          title={`${titleCase(decision.action)} ${decision.wo.documentNumber}`}
          description={
            decision.action === 'recover'
              ? 'Reverses the write-off journal and reinstates the receivable so cash can be applied.'
              : `${decision.wo.invoiceNumber}: ${decision.wo.currency} ${decision.wo.amount}`
          }
          label={decision.action === 'recover' ? 'Reason' : 'Comment'}
          required={decision.action !== 'approve'}
          confirmLabel={titleCase(decision.action)}
          destructive={decision.action === 'reject'}
          loading={act.isPending}
          onConfirm={async (text) => {
            try {
              await act.mutateAsync(
                decision.action === 'recover'
                  ? { id: decision.wo.id, action: 'recover', recoveryDate: today(), reason: text }
                  : { id: decision.wo.id, action: decision.action, comment: text || undefined },
              );
              toast.success(
                `${decision.wo.documentNumber} ${decision.action === 'recover' ? 'recovered' : decision.action + 'd'}.`,
              );
              setDecision(null);
            } catch (err) {
              toast.error(describeError(err));
            }
          }}
        />
      ) : null}
    </>
  );
}

export function NewWriteOffDialog({
  open,
  onOpenChange,
  invoiceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  invoiceId?: string;
}) {
  const create = useCreateWriteOff();
  const invoices = useDocuments(
    AR_CONFIG,
    { openOnly: true, pageSize: 100, documentType: 'INVOICE', sortBy: 'dueDate', sortDir: 'asc' },
    open && !invoiceId,
  );
  const [inv, setInv] = React.useState(invoiceId ?? '');
  const [reason, setReason] = React.useState<(typeof WRITE_OFF_REASONS)[number]>('BAD_DEBT');
  const [amount, setAmount] = React.useState('');
  const [justification, setJustification] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a write-off</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!invoiceId ? (
            <Field label="Invoice">
              <Select value={inv} onValueChange={setInv}>
                <SelectTrigger>
                  <SelectValue placeholder="Open invoice" />
                </SelectTrigger>
                <SelectContent>
                  {invoices.data?.items.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.documentNumber} - {i.customerName} ({i.balance}
                      {i.daysOverdue ? `, ${i.daysOverdue}d overdue` : ''})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Reason">
              <Select value={reason} onValueChange={(v) => setReason(v as typeof reason)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WRITE_OFF_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {titleCase(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Amount" hint="Blank = whole open balance">
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Justification">
            <Textarea
              rows={3}
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!inv || !justification.trim() || create.isPending}
            onClick={async () => {
              try {
                const wo = await create.mutateAsync({
                  invoiceId: inv,
                  reason,
                  amount: amount || undefined,
                  justification,
                });
                toast.success(`${wo.documentNumber} drafted - submit it for approval.`);
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProvisionsPanel() {
  const { hasPermission } = useSession();
  const provisions = useProvisions();
  const create = useCreateProvision();
  const act = useProvisionAction();
  const [asOf, setAsOf] = React.useState(today());
  const [reverse, setReverse] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader className="flex-row items-end justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Allowance for doubtful accounts</CardTitle>
          <CardDescription>
            Each run sizes the allowance from the aging rates in AR settings and posts only the
            adjustment (Dr bad-debt expense / Cr allowance).
          </CardDescription>
        </div>
        {hasPermission(P['write-off.post']) ? (
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-40"
            />
            <Button
              size="sm"
              disabled={create.isPending}
              onClick={async () => {
                try {
                  const r = await create.mutateAsync({ asOf, method: 'AGING_PERCENT' });
                  toast.success(`${r.documentNumber}: adjustment ${r.adjustment}.`);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Compute provision
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Run</TableHead>
              <TableHead>As of</TableHead>
              <TableHead className="text-right">Required</TableHead>
              <TableHead className="text-right">On books</TableHead>
              <TableHead className="text-right">Adjustment</TableHead>
              <TableHead>Journal</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {provisions.data?.length ? (
              provisions.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">{p.documentNumber}</TableCell>
                  <TableCell>{p.asOf}</TableCell>
                  <TableCell>
                    <Amount value={p.requiredAllowance} />
                  </TableCell>
                  <TableCell>
                    <Amount value={p.existingAllowance} />
                  </TableCell>
                  <TableCell>
                    <Amount value={p.adjustment} />
                  </TableCell>
                  <TableCell>
                    {p.journalNumber ? (
                      <Link
                        href={`/accounting/journal-entries/${p.journalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {p.journalNumber}
                      </Link>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={p.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {p.status === 'DRAFT' && hasPermission(P['write-off.post']) ? (
                      <Button
                        size="sm"
                        onClick={async () => {
                          try {
                            await act.mutateAsync({ id: p.id, action: 'post' });
                            toast.success('Provision posted.');
                          } catch (err) {
                            toast.error(describeError(err));
                          }
                        }}
                      >
                        Post
                      </Button>
                    ) : null}
                    {p.status === 'POSTED' && hasPermission(P['write-off.post']) ? (
                      <Button size="sm" variant="ghost" onClick={() => setReverse(p.id)}>
                        Reverse
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  No provision runs yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      <ReasonDialog
        open={Boolean(reverse)}
        onOpenChange={(o) => !o && setReverse(null)}
        title="Reverse the provision"
        confirmLabel="Reverse"
        destructive
        loading={act.isPending}
        onConfirm={async (reason) => {
          try {
            await act.mutateAsync({
              id: reverse!,
              action: 'reverse',
              reversalDate: today(),
              reason,
            });
            toast.success('Provision reversed.');
            setReverse(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </Card>
  );
}
