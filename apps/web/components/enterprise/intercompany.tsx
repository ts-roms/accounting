'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { INTERCOMPANY_STATUSES, P, type IntercompanyStatus } from '@accounting/types';
import { createIntercompanySchema, type CreateIntercompanyInput } from '@accounting/validation';
import {
  Badge,
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
  cn,
  StatusBadge,
} from '@accounting/ui';
import { api, describeError } from '@/lib/api/client';
import {
  useConsolidation,
  useCreateIntercompany,
  useDeleteIntercompany,
  useIntercompany,
  useIntercompanyAction,
} from '@/lib/api/enterprise-hooks';
import type { AccountNode, IntercompanyTransaction } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';
import { useQuery } from '@tanstack/react-query';
import { toneOf } from '@/components/status';
import { SettleIntercompanyDialog } from '@/components/consolidation/settle-dialog';

type IctFormInput = z.input<typeof createIntercompanySchema>;
const STATUS_VARIANT: Record<IntercompanyStatus, 'secondary' | 'success' | 'outline'> = {
  DRAFT: 'secondary',
  POSTED: 'success',
  SETTLED: 'success',
  REVERSED: 'outline',
};

/** Chart of another company (the account pickers are company-scoped, so we fetch with an explicit header). */
function useCompanyAccounts(companyId: string | null) {
  return useQuery({
    queryKey: ['accounts-of', companyId] as const,
    queryFn: () => api.get<AccountNode[]>('/accounts', { headers: { 'x-company-id': companyId! } }),
    enabled: Boolean(companyId),
  });
}

function AccountSelect({
  companyId,
  value,
  onChange,
  types,
  testId,
}: {
  companyId: string | null;
  value: string;
  onChange: (id: string) => void;
  types?: string[];
  testId?: string;
}) {
  const accounts = useCompanyAccounts(companyId);
  const options = (accounts.data ?? []).filter(
    (a) => !a.isHeader && a.status === 'ACTIVE' && (!types || types.includes(a.type)),
  );
  return (
    <Select value={value} onValueChange={onChange} disabled={!companyId}>
      <SelectTrigger data-testid={testId}>
        <SelectValue placeholder={companyId ? 'Select account' : 'Pick the company first'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.code} · {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function IntercompanyPage() {
  const { me } = useSession();
  const table = useTableState({ sortBy: 'transactionDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<IntercompanyTransaction | null>(null);
  const list = useIntercompany({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as IntercompanyStatus),
  });
  const companyName = (id: string) => me.companies.find((c) => c.id === id)?.code ?? id;
  const columns = React.useMemo<ColumnDef<IntercompanyTransaction>[]>(
    () => [
      {
        accessorKey: 'transactionDate',
        header: 'Date',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.transactionDate}</span>
        ),
      },
      {
        accessorKey: 'documentNumber',
        header: 'Number',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.documentNumber}</span>,
      },
      {
        id: 'flow',
        header: 'From → To',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.fromCompanyCode} → {row.original.toCompanyCode}
          </span>
        ),
      },
      {
        id: 'description',
        header: 'Description',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div>{row.original.description}</div>
            <div className="text-xs text-muted-foreground">
              Dr {row.original.fromAccountCode} · Cr {row.original.toAccountCode}
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
  void companyName;
  return (
    <>
      <PageHeader
        title="Intercompany"
        description="One event in two ledgers: the originating company debits an account and credits Due to Affiliates; the receiving company debits Due from Affiliates and credits an account. Both entries post atomically and eliminate on consolidation."
        actions={
          <Can permissions={[P['intercompany.post']]}>
            <Button onClick={() => setCreating(true)} data-testid="new-intercompany">
              <Plus /> New transaction
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={list.data}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(t) => t.id}
        onRowClick={(t) => setSelected(t)}
        toolbar={
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
              {INTERCOMPANY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <IntercompanyDialog open={creating} onOpenChange={setCreating} onCreated={setSelected} />
      <IntercompanyDetailDialog
        transaction={selected}
        onOpenChange={(o) => !o && setSelected(null)}
      />
    </>
  );
}

function IntercompanyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (t: IntercompanyTransaction) => void;
}) {
  const { me, activeCompany } = useSession();
  const create = useCreateIntercompany();
  const form = useForm<IctFormInput, unknown, CreateIntercompanyInput>({
    resolver: zodResolver(createIntercompanySchema),
    defaultValues: {
      fromCompanyId: activeCompany?.id ?? '',
      toCompanyId: '',
      transactionDate: today(),
      description: '',
      amount: '',
      fromAccountId: '',
      toAccountId: '',
    },
  });
  React.useEffect(() => {
    if (open)
      form.reset({
        fromCompanyId: activeCompany?.id ?? '',
        toCompanyId: me.companies.find((c) => c.id !== activeCompany?.id)?.id ?? '',
        transactionDate: today(),
        description: '',
        amount: '',
        fromAccountId: '',
        toAccountId: '',
      });
  }, [open, activeCompany, me.companies, form]);
  const fromCompanyId = form.watch('fromCompanyId');
  const toCompanyId = form.watch('toCompanyId');
  const submit = form.handleSubmit(async (values) => {
    try {
      const created = await create.mutateAsync({ ...values, idempotencyKey: crypto.randomUUID() });
      toast.success(`${created.documentNumber} drafted.`);
      onOpenChange(false);
      onCreated(created);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  const companyField = (name: 'fromCompanyId' | 'toCompanyId', label: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select
            value={field.value}
            onValueChange={(v) => {
              field.onChange(v);
              form.setValue(name === 'fromCompanyId' ? 'fromAccountId' : 'toAccountId', '');
            }}
          >
            <FormControl>
              <SelectTrigger data-testid={`ict-${name}`}>
                <SelectValue placeholder="Company" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {me.companies.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.code} · {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New intercompany transaction</DialogTitle>
          <DialogDescription>
            You need the intercompany permission in both companies. The amount is in the originating
            company&apos;s currency and converts on posting.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              {companyField('fromCompanyId', 'From company (debits)')}
              {companyField('toCompanyId', 'To company (credits)')}
              <FormField
                control={form.control}
                name="fromAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Debit account in the originating company</FormLabel>
                    <AccountSelect
                      companyId={fromCompanyId || null}
                      value={field.value}
                      onChange={field.onChange}
                      types={['EXPENSE', 'COST_OF_SALES', 'ASSET']}
                      testId="ict-from-account"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="toAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Credit account in the receiving company</FormLabel>
                    <AccountSelect
                      companyId={toCompanyId || null}
                      value={field.value}
                      onChange={field.onChange}
                      types={['REVENUE', 'LIABILITY', 'ASSET']}
                      testId="ict-to-account"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="transactionDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        className="text-right tabular"
                        {...field}
                        data-testid="ict-amount"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="ict-description" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reference</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} className="font-mono" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending} data-testid="ict-save">
                Save draft
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function IntercompanyDetailDialog({
  transaction: t,
  onOpenChange,
}: {
  transaction: IntercompanyTransaction | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { hasPermission } = useSession();
  const act = useIntercompanyAction();
  const remove = useDeleteIntercompany();
  const [reason, setReason] = React.useState('');
  const [reversing, setReversing] = React.useState(false);
  const [settling, setSettling] = React.useState(false);
  const [current, setCurrent] = React.useState<IntercompanyTransaction | null>(t);
  React.useEffect(() => {
    setCurrent(t);
    setReversing(false);
    setReason('');
  }, [t]);
  if (!current) return null;
  const c = current;
  const canPost = hasPermission(P['intercompany.post']);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="font-mono">{c.documentNumber}</span>
            <StatusBadge tone={toneOf(STATUS_VARIANT[c.status])}>{titleCase(c.status)}</StatusBadge>
          </DialogTitle>
          <DialogDescription>
            {c.transactionDate} · {c.description}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Amount</dt>
          <dd>
            <Amount value={c.amount} currency={c.currency} className="text-left font-semibold" />
          </dd>
          <dt className="text-muted-foreground">From</dt>
          <dd>
            {c.fromCompanyCode} · Dr {c.fromAccountCode}
            {c.fromJournalEntryId ? (
              <>
                {' '}
                ·{' '}
                <Link
                  href={`/accounting/journal-entries/${c.fromJournalEntryId}`}
                  className="font-mono text-xs hover:underline"
                >
                  {c.fromJournalNumber}
                </Link>
              </>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd>
            {c.toCompanyCode} · Cr {c.toAccountCode}
            {c.toJournalNumber ? (
              <span className="font-mono text-xs"> · {c.toJournalNumber}</span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Reference</dt>
          <dd>{c.reference ?? '-'}</dd>
          {c.status === 'SETTLED' ? (
            <>
              <dt className="text-muted-foreground">Settled</dt>
              <dd>
                {c.settlementDate}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {c.settlementFromJournalNumber} / {c.settlementToJournalNumber}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
        {canPost && c.status === 'POSTED' ? (
          <SettleIntercompanyDialog
            transaction={c}
            open={settling}
            onOpenChange={setSettling}
            onSettled={(r) => setCurrent(r)}
          />
        ) : null}
        {reversing ? (
          <div className="space-y-1">
            <Label>Reason</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
        ) : null}
        <DialogFooter>
          {canPost && c.status === 'DRAFT' ? (
            <>
              <Button
                variant="outline"
                disabled={remove.isPending}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(c.id);
                    toast.success('Draft deleted.');
                    onOpenChange(false);
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                Delete
              </Button>
              <Button
                disabled={act.isPending}
                data-testid="ict-post"
                onClick={async () => {
                  try {
                    const r = await act.mutateAsync({ id: c.id, action: 'post' });
                    setCurrent(r);
                    toast.success(`${r.documentNumber} posted in both companies.`);
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                Post
              </Button>
            </>
          ) : null}
          {canPost && c.status === 'POSTED' ? (
            reversing ? (
              <>
                <Button variant="outline" onClick={() => setReversing(false)}>
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  disabled={reason.trim().length < 3 || act.isPending}
                  onClick={async () => {
                    try {
                      const r = await act.mutateAsync({
                        id: c.id,
                        action: 'reverse',
                        reason: reason.trim(),
                      });
                      setCurrent(r);
                      toast.success('Reversed in both companies.');
                      setReversing(false);
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  Confirm reversal
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setReversing(true)}>
                  Reverse
                </Button>
                <Button onClick={() => setSettling(true)}>Settle in cash</Button>
              </>
            )
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------ consolidation

export function ConsolidationPage() {
  const { me } = useSession();
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const [currency, setCurrency] = React.useState<string>('');
  const report = useConsolidation({
    from: range.from,
    to: range.to,
    currency: currency || undefined,
  });
  const r = report.data;
  return (
    <>
      <PageHeader
        title="Consolidated trial balance"
        description="Every company's ledger translated to the presentation currency at the closing rate on the end date, combined by account code, with intercompany accounts eliminated."
        actions={
          <div className="flex items-center gap-2">
            <DateRange from={range.from} to={range.to} onChange={setRange} />
            <Input
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              placeholder={me.organization.baseCurrency}
              className="w-20 font-mono uppercase"
              maxLength={3}
            />
          </div>
        }
      />
      {report.isError ? (
        <p className="text-sm text-critical">{describeError(report.error)}</p>
      ) : report.isLoading || !r ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Assets"
              value={<Amount value={r.totals.assets} currency={r.currency} className="text-left" />}
            />
            <Stat
              label="Liabilities"
              value={
                <Amount value={r.totals.liabilities} currency={r.currency} className="text-left" />
              }
            />
            <Stat
              label="Equity"
              value={<Amount value={r.totals.equity} currency={r.currency} className="text-left" />}
            />
            <Stat
              label="Revenue"
              value={
                <Amount value={r.totals.revenue} currency={r.currency} className="text-left" />
              }
            />
            <Stat
              label="Net income"
              value={
                <Amount value={r.totals.netIncome} currency={r.currency} className="text-left" />
              }
            />
            <Stat
              label="Elimination check"
              value={
                <Amount
                  value={r.totals.eliminationCheck}
                  currency={r.currency}
                  className="text-left"
                  zeroAsDash
                />
              }
              hint={
                r.totals.balanced
                  ? 'Intercompany balances mirror'
                  : 'Intercompany balances do not net to zero'
              }
              danger={!r.totals.balanced}
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Group trial balance</CardTitle>
              <CardDescription>
                {r.companies
                  .map((c) => `${c.code} (${c.baseCurrency} @ ${Number(c.rate)})`)
                  .join(' · ')}{' '}
                → {r.currency}
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-[240px]">Account</TableHead>
                    {r.companies.map((c) => (
                      <TableHead key={c.id} className="min-w-[130px] text-right">
                        {c.code}
                      </TableHead>
                    ))}
                    <TableHead className="min-w-[130px] text-right">Combined</TableHead>
                    <TableHead className="min-w-[130px] text-right">Eliminations</TableHead>
                    <TableHead className="min-w-[130px] text-right">Consolidated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.map((row) => (
                    <TableRow
                      key={row.code}
                      className={cn('hover:bg-transparent', row.isIntercompany && 'bg-warning/8')}
                      data-testid="consolidation-row"
                    >
                      <TableCell>
                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                          {row.code}
                        </span>
                        {row.name}
                        {row.isIntercompany ? (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            IC
                          </Badge>
                        ) : null}
                      </TableCell>
                      {r.companies.map((c) => (
                        <TableCell key={c.id}>
                          <Amount value={row.byCompany[c.id] ?? '0'} zeroAsDash />
                        </TableCell>
                      ))}
                      <TableCell>
                        <Amount value={row.combined} />
                      </TableCell>
                      <TableCell>
                        <Amount value={row.eliminations} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={row.consolidated} className="font-medium" zeroAsDash />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={r.companies.length + 3}>
                      Net income (revenue − expenses)
                    </TableCell>
                    <TableCell>
                      <Amount
                        value={r.totals.netIncome}
                        currency={r.currency}
                        className="font-semibold"
                      />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
