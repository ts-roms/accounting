'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Money } from '@accounting/money';
import { EXPENSE_CLAIM_STATUSES, P, type ExpenseClaimStatus } from '@accounting/types';
import { createExpenseClaimSchema, type CreateExpenseClaimInput } from '@accounting/validation';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  StatusBadge,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateExpenseClaim,
  useDeleteExpenseClaim,
  useExpenseClaim,
  useExpenseClaimAction,
  useExpenseClaims,
  useTaxCodes,
  useUpdateExpenseClaim,
} from '@/lib/api/budgeting-tax-hooks';
import type { ExpenseClaim, ExpenseClaimDetail } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { BankAccountSelect } from '@/components/banking/shared';
import { DimensionsPopover, TaxCodeSelect, estimateRate } from '@/components/dimensions/pickers';
import { Field } from '@/components/fixed-assets/shared';
import { AttachmentsPanel } from '@/components/enterprise/attachments-panel';
import { toneOf } from '@/components/status';

export const CLAIMS_PATH = '/budgeting/expense-claims';
type ClaimFormInput = z.input<typeof createExpenseClaimSchema>;

const STATUS_VARIANT: Record<
  ExpenseClaimStatus,
  'secondary' | 'warning' | 'default' | 'destructive' | 'success' | 'outline'
> = {
  DRAFT: 'secondary',
  SUBMITTED: 'warning',
  APPROVED: 'default',
  REJECTED: 'destructive',
  POSTED: 'success',
  PAID: 'success',
  CANCELLED: 'outline',
};

export function ClaimStatusBadge({ status }: { status: ExpenseClaimStatus }) {
  return <StatusBadge tone={toneOf(STATUS_VARIANT[status])}>{titleCase(status)}</StatusBadge>;
}

export function ExpenseClaimsPage() {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'claimDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const claims = useExpenseClaims({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as ExpenseClaimStatus),
  });
  const columns = React.useMemo<ColumnDef<ExpenseClaim>[]>(
    () => [
      {
        accessorKey: 'claimDate',
        header: 'Date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.claimDate}</span>,
      },
      {
        accessorKey: 'claimNumber',
        header: 'Number',
        cell: ({ row }) => (
          <Link
            href={`${CLAIMS_PATH}/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.claimNumber}
          </Link>
        ),
      },
      {
        id: 'claimant',
        header: 'Claimant',
        enableSorting: false,
        cell: ({ row }) => row.original.claimantName,
      },
      {
        id: 'purpose',
        header: 'Purpose',
        enableSorting: false,
        cell: ({ row }) => <span className="text-sm">{row.original.purpose}</span>,
      },
      {
        id: 'total',
        header: () => <div className="text-right">Total</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.total} currency={row.original.currency} />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <ClaimStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Expense claims"
        description="Employee reimbursements: submit -> approve (by someone else) -> post (Dr expense / input tax, Cr due to employees) -> pay from a bank account."
        actions={
          <Can permissions={[P['expense-claim.create']]}>
            <Button asChild data-testid="new-claim">
              <Link href={`${CLAIMS_PATH}/new`}>
                <Plus /> New claim
              </Link>
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={claims.data}
        isLoading={claims.isLoading}
        isFetching={claims.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(c) => c.id}
        onRowClick={(c) => router.push(`${CLAIMS_PATH}/${c.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Number, purpose, claimant"
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
                {EXPENSE_CLAIM_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
    </>
  );
}

const emptyLine = (): ClaimFormInput['lines'][number] => ({
  expenseDate: today(),
  description: '',
  accountId: '',
  amount: '',
  taxCodeId: null,
  departmentId: null,
  costCenterId: null,
  projectId: null,
});

function trim(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' ? '0' : t;
}

export function ExpenseClaimForm({ claim }: { claim?: ExpenseClaimDetail }) {
  const router = useAppRouter();
  const create = useCreateExpenseClaim();
  const update = useUpdateExpenseClaim();
  const taxCodes = useTaxCodes('PURCHASES');
  const form = useForm<ClaimFormInput, unknown, CreateExpenseClaimInput>({
    resolver: zodResolver(createExpenseClaimSchema),
    defaultValues: claim
      ? {
          claimDate: claim.claimDate,
          purpose: claim.purpose,
          notes: claim.notes ?? undefined,
          lines: claim.lines.map((l) => ({
            expenseDate: l.expenseDate,
            description: l.description,
            merchant: l.merchant ?? undefined,
            receiptReference: l.receiptReference ?? undefined,
            accountId: l.accountId,
            amount: trim(l.amount),
            taxCodeId: l.taxCodeId,
            departmentId: l.departmentId ?? null,
            costCenterId: l.costCenterId ?? null,
            projectId: l.projectId ?? null,
          })),
        }
      : { claimDate: today(), purpose: '', lines: [emptyLine()] },
    mode: 'onBlur',
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const watched = useWatch({ control: form.control, name: 'lines' });
  const currency = claim?.currency ?? 'PHP';
  const amounts = (watched ?? []).map((l) =>
    /^\d+(\.\d+)?$/.test((l?.amount ?? '').trim())
      ? Money.parse(l!.amount.trim(), currency)
      : Money.zero(currency),
  );
  const total = Money.sum(amounts, currency);
  const taxEstimate = Money.sum(
    amounts.map((a, i) => {
      const rate = estimateRate(taxCodes.data, watched?.[i]?.taxCodeId);
      if (rate === '0') return Money.zero(currency);
      const divisor = Money.of('1', currency).add(Money.of(rate, currency).multiply('0.01'));
      return a.subtract(a.divide(divisor.toString()));
    }),
    currency,
  );
  const submit = form.handleSubmit(async (values) => {
    try {
      const saved = claim
        ? await update.mutateAsync({ id: claim.id, ...values })
        : await create.mutateAsync(values);
      toast.success(`${saved.claimNumber} ${claim ? 'updated' : 'saved as a draft'}.`);
      router.push(`${CLAIMS_PATH}/${saved.id}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Card>
          <CardContent className="grid gap-3 p-4 md:grid-cols-[160px_1fr]">
            <FormField
              control={form.control}
              name="claimDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Claim date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="purpose"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Purpose</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="Client visit, conference, supplies…"
                      data-testid="claim-purpose"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Expenses</CardTitle>
            <CardDescription>
              Amounts are what you paid, tax inclusive; the tax code carves the input tax out of the
              gross.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">#</TableHead>
                  <TableHead className="w-36">Date</TableHead>
                  <TableHead className="min-w-[200px]">Description</TableHead>
                  <TableHead className="min-w-[160px]">Merchant / receipt</TableHead>
                  <TableHead className="min-w-[220px]">Expense account</TableHead>
                  <TableHead className="w-32">Tax</TableHead>
                  <TableHead className="w-32 text-right">Amount</TableHead>
                  <TableHead className="w-12" />
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.fields.map((f, index) => (
                  <TableRow key={f.id} className="hover:bg-transparent">
                    <TableCell className="text-xs text-muted-foreground">{index + 1}</TableCell>
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${index}.expenseDate`}
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input type="date" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${index}.description`}
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                {...field}
                                placeholder="What was bought"
                                data-testid="claim-line-description"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </TableCell>
                    <TableCell className="space-y-1">
                      <FormField
                        control={form.control}
                        name={`lines.${index}.merchant`}
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                {...field}
                                value={field.value ?? ''}
                                placeholder="Merchant"
                                className="h-8 text-xs"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`lines.${index}.receiptReference`}
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                {...field}
                                value={field.value ?? ''}
                                placeholder="Receipt no."
                                className="h-8 font-mono text-xs"
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${index}.accountId`}
                        render={({ field }) => (
                          <FormItem>
                            <AccountCombobox
                              value={field.value}
                              onChange={(id) => field.onChange(id)}
                              types={['EXPENSE', 'ASSET']}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <TaxCodeSelect
                        side="PURCHASES"
                        kind="SALES_TAX"
                        value={watched?.[index]?.taxCodeId}
                        onChange={(id) =>
                          form.setValue(`lines.${index}.taxCodeId`, id, { shouldDirty: true })
                        }
                        testId="claim-line-tax"
                      />
                    </TableCell>
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${index}.amount`}
                        render={({ field }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                inputMode="decimal"
                                className="text-right tabular"
                                {...field}
                                data-testid="claim-line-amount"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <DimensionsPopover
                        value={{
                          departmentId: watched?.[index]?.departmentId,
                          costCenterId: watched?.[index]?.costCenterId,
                          projectId: watched?.[index]?.projectId,
                        }}
                        onChange={(next) => {
                          form.setValue(`lines.${index}.departmentId`, next.departmentId ?? null, {
                            shouldDirty: true,
                          });
                          form.setValue(`lines.${index}.costCenterId`, next.costCenterId ?? null, {
                            shouldDirty: true,
                          });
                          form.setValue(`lines.${index}.projectId`, next.projectId ?? null, {
                            shouldDirty: true,
                          });
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove line"
                        disabled={lines.fields.length <= 1}
                        onClick={() => lines.remove(index)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => lines.append(emptyLine())}
                    >
                      <Plus /> Add line
                    </Button>
                  </TableCell>
                  <TableCell colSpan={3}>
                    <dl className="ml-auto grid w-64 grid-cols-[1fr_auto] gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Input tax (est.)</dt>
                      <dd>
                        <Amount value={taxEstimate.toString()} currency={currency} zeroAsDash />
                      </dd>
                      <dt className="font-semibold">Total to reimburse</dt>
                      <dd>
                        <span data-testid="claim-total">
                          <Amount
                            value={total.toString()}
                            currency={currency}
                            className="font-semibold"
                          />
                        </span>
                      </dd>
                    </dl>
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(claim ? `${CLAIMS_PATH}/${claim.id}` : CLAIMS_PATH)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={create.isPending || update.isPending || total.isZero()}
            data-testid="claim-save"
          >
            {claim ? 'Save' : 'Save draft'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

export function NewExpenseClaimPage() {
  return (
    <>
      <PageHeader
        title="New expense claim"
        description="Saved as a draft under your name; submit it from the claim page."
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href={CLAIMS_PATH}>
              <ArrowLeft /> Claims
            </Link>
          </Button>
        }
      />
      <ExpenseClaimForm />
    </>
  );
}

export function ExpenseClaimDetailPage({ id }: { id: string }) {
  const router = useAppRouter();
  const { hasPermission, me } = useSession();
  const claim = useExpenseClaim(id);
  const act = useExpenseClaimAction();
  const remove = useDeleteExpenseClaim();
  const [editing, setEditing] = React.useState(false);
  const [reasonFor, setReasonFor] = React.useState<'reject' | 'cancel' | null>(null);
  const [reason, setReason] = React.useState('');
  const [paying, setPaying] = React.useState(false);
  const [bankAccountId, setBankAccountId] = React.useState<string | null>(null);
  const [paymentDate, setPaymentDate] = React.useState(today());
  const [reference, setReference] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  if (claim.isLoading || !claim.data) return <Skeleton className="h-96" />;
  const c = claim.data;
  const mine = me.user.id === c.claimantUserId;
  const canCreate = hasPermission(P['expense-claim.create']);
  const canApprove = hasPermission(P['expense-claim.approve']);
  const canPost = hasPermission(P['expense-claim.post']);
  const run = async (a: Parameters<typeof act.mutateAsync>[0]) => {
    try {
      const r = await act.mutateAsync(a);
      toast.success(`${r.claimNumber} ${titleCase(r.status).toLowerCase()}.`);
      setReasonFor(null);
      setReason('');
      setPaying(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  if (editing) {
    return (
      <>
        <PageHeader
          title={`Edit ${c.claimNumber}`}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              <ArrowLeft /> Back
            </Button>
          }
        />
        <ExpenseClaimForm claim={c} />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{c.claimNumber}</span>
            <ClaimStatusBadge status={c.status} />
          </span>
        }
        description={`${c.claimantName} · ${c.claimDate} · ${c.purpose}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={CLAIMS_PATH}>
                <ArrowLeft /> Claims
              </Link>
            </Button>
            {canCreate && (c.status === 'DRAFT' || c.status === 'REJECTED') ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                  <Trash2 /> Delete
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  onClick={() => run({ id: c.id, action: 'submit' })}
                  data-testid="claim-submit"
                >
                  Submit
                </Button>
              </>
            ) : null}
            {canCreate && (c.status === 'SUBMITTED' || c.status === 'APPROVED') ? (
              <Button variant="outline" size="sm" onClick={() => setReasonFor('cancel')}>
                Cancel claim
              </Button>
            ) : null}
            {canApprove && c.status === 'SUBMITTED' ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setReasonFor('reject')}>
                  Reject
                </Button>
                <Button
                  size="sm"
                  disabled={mine}
                  title={mine ? 'You cannot approve your own claim' : undefined}
                  onClick={() => run({ id: c.id, action: 'approve' })}
                  data-testid="claim-approve"
                >
                  Approve
                </Button>
              </>
            ) : null}
            {canPost && c.status === 'APPROVED' ? (
              <Button
                size="sm"
                onClick={() => run({ id: c.id, action: 'post' })}
                data-testid="claim-post"
              >
                Post
              </Button>
            ) : null}
            {canPost && c.status === 'POSTED' ? (
              <Button size="sm" onClick={() => setPaying(true)} data-testid="claim-pay">
                Pay
              </Button>
            ) : null}
          </>
        }
      />
      {c.status === 'REJECTED' ? (
        <Alert variant="destructive">
          <AlertTitle>Rejected</AlertTitle>
          <AlertDescription>{c.rejectionReason}</AlertDescription>
        </Alert>
      ) : null}
      {mine && c.status === 'SUBMITTED' ? (
        <Alert>
          <AlertTitle>Awaiting approval</AlertTitle>
          <AlertDescription>
            Someone other than the claimant has to approve this claim.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Tax</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.lines.map((l) => (
                  <TableRow key={l.id} data-testid="claim-line">
                    <TableCell className="text-xs text-muted-foreground">{l.lineNumber}</TableCell>
                    <TableCell className="whitespace-nowrap">{l.expenseDate}</TableCell>
                    <TableCell>
                      <div>{l.description}</div>
                      <div className="text-xs text-muted-foreground">
                        {[l.merchant, l.receiptReference].filter(Boolean).join(' · ')}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="mr-1 font-mono text-xs text-muted-foreground">
                        {l.accountCode}
                      </span>
                      {l.accountName}
                    </TableCell>
                    <TableCell className="text-xs">
                      {l.taxCode ? `${l.taxCode} ${Number(l.taxRate)}% = ${l.taxAmount}` : '-'}
                    </TableCell>
                    <TableCell>
                      <Amount value={l.amount} currency={c.currency} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Input tax
                  </TableCell>
                  <TableCell>
                    <Amount value={c.taxTotal} currency={c.currency} zeroAsDash />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Total ({c.currency})
                  </TableCell>
                  <TableCell>
                    <Amount value={c.total} currency={c.currency} className="font-semibold" />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
              <Field
                label="Claimant"
                value={
                  <span>
                    {c.claimantName}
                    <div className="text-xs text-muted-foreground">{c.claimantEmail}</div>
                  </span>
                }
              />
              <Field label="Submitted" value={formatDateTime(c.submittedAt)} />
              <Field label="Approved" value={formatDateTime(c.approvedAt)} />
              <Field
                label="Posted"
                value={
                  c.journalEntryId ? (
                    <Link
                      href={`/accounting/journal-entries/${c.journalEntryId}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {c.journalNumber}
                    </Link>
                  ) : (
                    '-'
                  )
                }
              />
              <Field
                label="Paid"
                value={
                  c.paymentJournalEntryId ? (
                    <span>
                      <Link
                        href={`/accounting/journal-entries/${c.paymentJournalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {c.paymentJournalNumber}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {c.paymentDate} {c.paymentReference ?? ''}
                      </div>
                    </span>
                  ) : (
                    '-'
                  )
                }
              />
              {c.notes ? <Field label="Notes" value={c.notes} /> : null}
            </dl>
          </CardContent>
        </Card>
        <AttachmentsPanel entityType="EXPENSE_CLAIM" entityId={c.id} />
      </div>
      <Dialog open={Boolean(reasonFor)} onOpenChange={(o) => !o && setReasonFor(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{reasonFor === 'reject' ? 'Reject claim' : 'Cancel claim'}</DialogTitle>
            <DialogDescription>
              {reasonFor === 'reject'
                ? 'The claimant can fix and resubmit.'
                : 'A cancelled claim cannot be reopened.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Reason</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonFor(null)}>
              Back
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3 || act.isPending}
              onClick={() => run({ id: c.id, action: reasonFor!, reason: reason.trim() })}
            >
              {reasonFor === 'reject' ? 'Reject' : 'Cancel claim'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={paying} onOpenChange={setPaying}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reimburse {c.claimNumber}</DialogTitle>
            <DialogDescription>
              Dr due to employees / Cr the bank GL account for {c.total}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Bank account</Label>
              <BankAccountSelect
                value={bankAccountId}
                onChange={setBankAccountId}
                testId="pay-bank-account"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Payment date</Label>
                <Input
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Reference</Label>
                <Input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className="font-mono"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaying(false)}>
              Cancel
            </Button>
            <Button
              disabled={!bankAccountId || act.isPending}
              data-testid="pay-confirm"
              onClick={() =>
                run({
                  id: c.id,
                  action: 'pay',
                  bankAccountId: bankAccountId!,
                  paymentDate,
                  reference: reference.trim() || undefined,
                })
              }
            >
              Pay
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${c.claimNumber}?`}
        description="Drafts have no ledger effect and can be removed."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(c.id);
            toast.success('Claim deleted.');
            router.push(CLAIMS_PATH);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
