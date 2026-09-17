'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Phone, Play, Plus, Search, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { COLLECTION_ACTIVITY_TYPES } from '@accounting/types';
import { COLLECTION_CASE_STATUSES, P } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
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
  Skeleton,
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
import { useUsers } from '@/lib/api/hooks';
import {
  useAddActivity,
  useCaseCreditHold,
  useCollectionCase,
  useCollectionCases,
  useCreateCase,
  useCreatePromise,
  useRunSweep,
  useUpdateCase,
  useUpdatePromise,
} from '@/lib/api/receivables-hooks';
import type { CollectionCase, CollectionCaseDetail } from '@/lib/api/receivables-types';
import { AR_CONFIG } from '@/lib/subledger/config';
import { useSession } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { DescriptionList, Field, ReasonDialog, StatusBadge } from './shared';

export function CollectionsPage() {
  const router = useAppRouter();
  const table = useTableState({ sortDir: 'desc' });
  const [status, setStatus] = React.useState('OPEN');
  const [create, setCreate] = React.useState(false);
  const sweep = useRunSweep();
  const cases = useCollectionCases({
    ...table.query,
    openOnly: status === 'OPEN' || undefined,
    status:
      status === 'OPEN' || status === 'ALL' ? undefined : (status as CollectionCase['status']),
  });
  const columns = React.useMemo<ColumnDef<CollectionCase>[]>(
    () => [
      {
        id: 'customer',
        header: 'Customer',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-xs">
            <div className="truncate font-medium">{row.original.customerName}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {row.original.documentNumber}
            </div>
          </div>
        ),
      },
      {
        id: 'overdue',
        header: () => <div className="text-right">Overdue</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.overdue} className="text-destructive" />,
      },
      {
        id: 'days',
        header: 'Days',
        enableSorting: false,
        cell: ({ row }) => (row.original.daysOverdue ? `${row.original.daysOverdue}d` : '-'),
      },
      {
        id: 'lastContact',
        header: 'Last contact',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.lastContactAt ? formatDateTime(row.original.lastContactAt) : '-',
      },
      {
        id: 'next',
        header: 'Next action',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-xs truncate text-xs">
            {row.original.nextActionAt ? `${row.original.nextActionAt}: ` : ''}
            {row.original.nextAction ?? '-'}
          </div>
        ),
      },
      {
        id: 'promise',
        header: 'Promise',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.openPromise ? (
            <span className="text-xs">
              <Amount value={row.original.openPromise.amount} className="inline" /> by{' '}
              {row.original.openPromise.promiseDate}
            </span>
          ) : (
            '-'
          ),
      },
      {
        id: 'collector',
        header: 'Collector',
        enableSorting: false,
        cell: ({ row }) => row.original.collectorName ?? '-',
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
        title="Collections"
        description="Overdue customers, promises to pay, escalations and dunning. Balances come from the subledger; nothing here posts."
        actions={
          <>
            <Can permissions={[P['collection.manage']]}>
              <Button
                variant="outline"
                size="sm"
                disabled={sweep.isPending}
                onClick={async () => {
                  try {
                    const r = await sweep.mutateAsync(undefined);
                    toast.success(
                      `Sweep: ${r.overdue} overdue, ${r.dunningSteps} dunning steps, ${r.casesOpened} cases opened, ${r.promisesEvaluated} promises evaluated.`,
                    );
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                <Play /> Run dunning now
              </Button>
              <Button size="sm" onClick={() => setCreate(true)}>
                <Plus /> New case
              </Button>
            </Can>
          </>
        }
      />
      <DataTable
        columns={columns}
        data={cases.data}
        isLoading={cases.isLoading}
        isFetching={cases.isFetching}
        pagination={table.pagination}
        getRowId={(c) => c.id}
        onRowClick={(c) => router.push(`/receivables/collections/${c.id}`)}
        emptyState={
          <EmptyState
            icon={Phone}
            title="No collection cases"
            description="Cases open when invoices go overdue (per your AR settings) or by hand."
          />
        }
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Customer or case"
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
                <SelectItem value="OPEN">Open cases</SelectItem>
                <SelectItem value="ALL">All</SelectItem>
                {COLLECTION_CASE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <NewCaseDialog
        open={create}
        onOpenChange={setCreate}
        onCreated={(id) => router.push(`/receivables/collections/${id}`)}
      />
    </>
  );
}

function NewCaseDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateCase();
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [nextAction, setNextAction] = React.useState('');
  const [nextActionAt, setNextActionAt] = React.useState(today());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New collection case</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Customer">
            <PartyCombobox
              cfg={AR_CONFIG}
              value={customerId}
              onChange={(id) => setCustomerId(id)}
            />
          </Field>
          <Field label="Next action">
            <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
          </Field>
          <Field label="Due">
            <Input
              type="date"
              value={nextActionAt}
              onChange={(e) => setNextActionAt(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!customerId || create.isPending}
            onClick={async () => {
              try {
                const c = await create.mutateAsync({
                  customerId: customerId!,
                  nextAction: nextAction || undefined,
                  nextActionAt,
                });
                onOpenChange(false);
                onCreated(c.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Open case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CollectionCaseDetailPage({ id }: { id: string }) {
  const { hasPermission } = useSession();
  const detail = useCollectionCase(id);
  const update = useUpdateCase();
  const addActivity = useAddActivity();
  const createPromise = useCreatePromise();
  const updatePromise = useUpdatePromise();
  const hold = useCaseCreditHold();
  const users = useUsers({ pageSize: 100 });
  const [activity, setActivity] = React.useState(false);
  const [promise, setPromise] = React.useState(false);
  const [escalate, setEscalate] = React.useState(false);
  const [holdDialog, setHoldDialog] = React.useState<null | boolean>(null);
  if (!detail.data) return <Skeleton className="h-96" />;
  const c = detail.data;
  const canManage = hasPermission(P['collection.manage']);
  const open = !['COLLECTED', 'CLOSED'].includes(c.status);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {c.customerName} <StatusBadge status={c.status} />
          </span>
        }
        description={`${c.documentNumber} - opened ${formatDateTime(c.openedAt)} - ${c.source.toLowerCase()}${c.escalationLevel ? ` - escalation level ${c.escalationLevel}` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/receivables/collections">
                <ArrowLeft /> All cases
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`${AR_CONFIG.party.path}/${c.customerId}`}>Customer</Link>
            </Button>
            {canManage && open ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setActivity(true)}>
                  <Phone /> Record contact
                </Button>
                <Button variant="outline" size="sm" onClick={() => setPromise(true)}>
                  Promise to pay
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEscalate(true)}>
                  <ShieldAlert /> Escalate
                </Button>
              </>
            ) : null}
            <Can permissions={[P['customer.credit-manage']]}>
              <Button variant="destructive" size="sm" onClick={() => setHoldDialog(true)}>
                Credit hold
              </Button>
            </Can>
            {canManage && open ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    await update.mutateAsync({ id, status: 'CLOSED' });
                    toast.success('Case closed.');
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                Close case
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Outstanding" value={c.outstanding} />
        <Stat label="Overdue" value={c.overdue} danger />
        <Stat label="Days overdue" value={String(c.daysOverdue)} plain />
        <Stat
          label="Next action"
          value={c.nextActionAt ? `${c.nextActionAt}` : '-'}
          plain
          hint={c.nextAction ?? undefined}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Tabs defaultValue="activities">
            <TabsList>
              <TabsTrigger value="activities">Activities</TabsTrigger>
              <TabsTrigger value="invoices">Open invoices</TabsTrigger>
              <TabsTrigger value="promises">Promises</TabsTrigger>
            </TabsList>
            <TabsContent value="activities">
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>When</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Summary</TableHead>
                        <TableHead>By</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.activities.length ? (
                        c.activities.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell className="whitespace-nowrap text-xs">
                              {formatDateTime(a.performedAt)}
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={a.activityType} />
                            </TableCell>
                            <TableCell>
                              <div>{a.summary}</div>
                              {a.details ? (
                                <div className="text-xs text-muted-foreground">{a.details}</div>
                              ) : null}
                              {a.invoiceNumber ? (
                                <Link
                                  href={`${AR_CONFIG.document.path}/${a.invoiceId}`}
                                  className="font-mono text-xs hover:underline"
                                >
                                  {a.invoiceNumber}
                                </Link>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-xs">
                              {a.performedByName ??
                                (a.dunningStep !== null ? 'Dunning policy' : 'System')}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={4}
                            className="py-8 text-center text-sm text-muted-foreground"
                          >
                            No activity yet.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="invoices">
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Invoice</TableHead>
                        <TableHead>Due</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead className="text-right">Balance</TableHead>
                        <TableHead>Flags</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.invoices.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell>
                            <Link
                              href={`${AR_CONFIG.document.path}/${i.id}`}
                              className="font-mono text-xs hover:underline"
                            >
                              {i.documentNumber}
                            </Link>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {i.dueDate}
                            {i.daysOverdue ? (
                              <span className="ml-1 text-xs text-destructive">
                                +{i.daysOverdue}d
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Amount value={i.total} />
                          </TableCell>
                          <TableCell>
                            <Amount value={i.balance} />
                          </TableCell>
                          <TableCell>
                            {i.openDisputes ? <StatusBadge status="DISPUTED" /> : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="promises">
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Promised by</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Received</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.promises.length ? (
                        c.promises.map((p) => (
                          <TableRow key={p.id}>
                            <TableCell>
                              {p.promiseDate}
                              {p.notes ? (
                                <div className="text-xs text-muted-foreground">{p.notes}</div>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <Amount value={p.amount} />
                            </TableCell>
                            <TableCell>
                              <Amount value={p.settledAmount} zeroAsDash />
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={p.status} />
                            </TableCell>
                            <TableCell className="text-right">
                              {canManage && p.status === 'PENDING' ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={async () => {
                                    try {
                                      await updatePromise.mutateAsync({
                                        id: p.id,
                                        status: 'CANCELLED',
                                      });
                                    } catch (err) {
                                      toast.error(describeError(err));
                                    }
                                  }}
                                >
                                  Cancel
                                </Button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={5}
                            className="py-8 text-center text-sm text-muted-foreground"
                          >
                            No promises recorded.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Case</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <DescriptionList
              items={[
                [
                  'Customer',
                  <Link
                    key="c"
                    href={`${AR_CONFIG.party.path}/${c.customerId}`}
                    className="hover:underline"
                  >
                    {c.customerCode}
                  </Link>,
                ],
                ['Last contact', c.lastContactAt ? formatDateTime(c.lastContactAt) : '-'],
                ['Escalation', String(c.escalationLevel)],
                ['Notes', c.notes],
              ]}
            />
            {canManage ? (
              <Field label="Collector">
                <Select
                  value={c.collectorId ?? 'none'}
                  onValueChange={async (v) => {
                    try {
                      await update.mutateAsync({ id, collectorId: v === 'none' ? null : v });
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {users.data?.items.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.firstName} {u.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <ActivityDialog
        open={activity}
        onOpenChange={setActivity}
        caseDetail={c}
        onSubmit={async (input) => {
          try {
            await addActivity.mutateAsync({ id, ...input });
            toast.success('Activity recorded.');
            setActivity(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <PromiseDialog
        open={promise}
        onOpenChange={setPromise}
        caseDetail={c}
        onSubmit={async (input) => {
          try {
            await createPromise.mutateAsync({
              customerId: c.customerId,
              caseId: id,
              invoiceIds: [],
              ...input,
            });
            toast.success('Promise recorded.');
            setPromise(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ReasonDialog
        open={escalate}
        onOpenChange={setEscalate}
        title="Escalate the case"
        label="Why"
        confirmLabel="Escalate"
        onConfirm={async (reason) => {
          try {
            await addActivity.mutateAsync({ id, activityType: 'ESCALATION', summary: reason });
            toast.success('Escalated.');
            setEscalate(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <ReasonDialog
        open={holdDialog === true}
        onOpenChange={(o) => setHoldDialog(o ? true : null)}
        title={`Place ${c.customerName} on credit hold?`}
        description="New sales orders and invoices are blocked until the hold is released. This is audited and notifies credit managers."
        confirmLabel="Place on hold"
        destructive
        loading={hold.isPending}
        onConfirm={async (reason) => {
          try {
            await hold.mutateAsync({ id, hold: true, reason });
            toast.success('Customer placed on credit hold.');
            setHoldDialog(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

function ActivityDialog({
  open,
  onOpenChange,
  caseDetail,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  caseDetail: CollectionCaseDetail;
  onSubmit: (input: {
    activityType: (typeof COLLECTION_ACTIVITY_TYPES)[number];
    summary: string;
    details?: string;
    contactName?: string;
    nextActionAt?: string | null;
    nextAction?: string;
    invoiceId?: string | null;
  }) => Promise<void>;
}) {
  const [type, setType] = React.useState<(typeof COLLECTION_ACTIVITY_TYPES)[number]>('CALL');
  const [summary, setSummary] = React.useState('');
  const [details, setDetails] = React.useState('');
  const [contact, setContact] = React.useState('');
  const [nextAt, setNextAt] = React.useState('');
  const [next, setNext] = React.useState('');
  const [invoiceId, setInvoiceId] = React.useState('none');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record activity</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['CALL', 'EMAIL', 'MEETING', 'LETTER', 'NOTE'].map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Contact person">
            <Input value={contact} onChange={(e) => setContact(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Summary">
              <Input value={summary} onChange={(e) => setSummary(e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Details">
              <Textarea rows={3} value={details} onChange={(e) => setDetails(e.target.value)} />
            </Field>
          </div>
          <Field label="Invoice">
            <Select value={invoiceId} onValueChange={setInvoiceId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Whole account</SelectItem>
                {caseDetail.invoices.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.documentNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Next action date">
            <Input type="date" value={nextAt} onChange={(e) => setNextAt(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Next action">
              <Input value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!summary.trim()}
            onClick={() =>
              void onSubmit({
                activityType: type,
                summary,
                details: details || undefined,
                contactName: contact || undefined,
                nextActionAt: nextAt || undefined,
                nextAction: next || undefined,
                invoiceId: invoiceId === 'none' ? null : invoiceId,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromiseDialog({
  open,
  onOpenChange,
  caseDetail,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  caseDetail: CollectionCaseDetail;
  onSubmit: (input: {
    amount: string;
    promiseDate: string;
    notes?: string;
    invoiceIds?: string[];
  }) => Promise<void>;
}) {
  const [amount, setAmount] = React.useState(caseDetail.overdue);
  const [date, setDate] = React.useState(today());
  const [notes, setNotes] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promise to pay</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount">
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Promised by">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
          <Field label="Invoices covered">
            <div className="max-h-40 space-y-1 overflow-auto rounded-md border p-2 text-sm">
              {caseDetail.invoices.map((i) => (
                <label key={i.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={selected.includes(i.id)}
                    onCheckedChange={(v) =>
                      setSelected((s) => (v ? [...s, i.id] : s.filter((x) => x !== i.id)))
                    }
                  />
                  <span className="font-mono text-xs">{i.documentNumber}</span>
                  <Amount value={i.balance} className="ml-auto inline" />
                </label>
              ))}
            </div>
          </Field>
          <Field label="Notes">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!amount || !date}
            onClick={() =>
              void onSubmit({
                amount,
                promiseDate: date,
                notes: notes || undefined,
                invoiceIds: selected,
              })
            }
          >
            Record promise
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  danger,
  plain,
  hint,
}: {
  label: string;
  value: string;
  danger?: boolean;
  plain?: boolean;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        {plain ? (
          <div className="text-lg font-semibold">{value}</div>
        ) : (
          <Amount
            value={value}
            className={`text-lg font-semibold ${danger && value !== '0.0000' ? 'text-destructive' : ''}`}
          />
        )}
        {hint ? <div className="truncate text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
