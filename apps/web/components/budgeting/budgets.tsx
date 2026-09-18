'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Check, Copy, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Money } from '@accounting/money';
import { BUDGET_STATUSES, P, type BudgetStatus, type BudgetVersionStatus } from '@accounting/types';
import { createBudgetSchema, type CreateBudgetInput } from '@accounting/validation';
import {
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
import { useFiscalYears } from '@/lib/api/accounting-hooks';
import { describeError } from '@/lib/api/client';
import {
  useApproveBudgetVersion,
  useBudget,
  useBudgetVersion,
  useBudgets,
  useCreateBudget,
  useCreateBudgetVersion,
  useDeleteBudgetVersion,
  useReplaceBudgetLines,
  useUpdateBudget,
} from '@/lib/api/budgeting-tax-hooks';
import type {
  Budget,
  BudgetDetail,
  BudgetLine,
  BudgetPeriod,
  DimensionRefs,
} from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { AccountCombobox, Amount } from '@/components/accounting/primitives';
import { DimensionsPopover } from '@/components/dimensions/pickers';
import { toneOf } from '@/components/status';

export const BUDGETS_PATH = '/budgeting/budgets';
type BudgetFormInput = z.input<typeof createBudgetSchema>;

const STATUS_VARIANT: Record<BudgetStatus, 'secondary' | 'success' | 'outline'> = {
  DRAFT: 'secondary',
  ACTIVE: 'success',
  ARCHIVED: 'outline',
};
const VERSION_VARIANT: Record<BudgetVersionStatus, 'secondary' | 'success' | 'outline'> = {
  DRAFT: 'secondary',
  APPROVED: 'success',
  SUPERSEDED: 'outline',
};

export function BudgetsPage() {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'code', sortDir: 'asc' });
  const [status, setStatus] = React.useState('ALL');
  const [creating, setCreating] = React.useState(false);
  const budgets = useBudgets({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as BudgetStatus),
  });
  const columns = React.useMemo<ColumnDef<Budget>[]>(
    () => [
      {
        accessorKey: 'code',
        header: 'Code',
        cell: ({ row }) => (
          <Link
            href={`${BUDGETS_PATH}/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.code}
          </Link>
        ),
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.name}</div>
            <div className="text-xs text-muted-foreground">{row.original.fiscalYearName}</div>
          </div>
        ),
      },
      {
        id: 'versions',
        header: 'Versions',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.versionCount} · approved: {row.original.approvedVersionName ?? 'none'}
          </span>
        ),
      },
      {
        id: 'total',
        header: () => <div className="text-right">Approved total</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount value={row.original.approvedTotal} currency={row.original.currency} zeroAsDash />
        ),
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
        title="Budgets"
        description="Planned amounts per account and period, versioned. Approving a version locks it and makes it the baseline actuals are compared against."
        actions={
          <Can permissions={[P['budget.manage']]}>
            <Button onClick={() => setCreating(true)} data-testid="new-budget">
              <Plus /> New budget
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={budgets.data}
        isLoading={budgets.isLoading}
        isFetching={budgets.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(b) => b.id}
        onRowClick={(b) => router.push(`${BUDGETS_PATH}/${b.id}`)}
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
              {BUDGET_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <BudgetDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => router.push(`${BUDGETS_PATH}/${id}`)}
      />
    </>
  );
}

function BudgetDialog({
  open,
  budget,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  budget?: Budget;
  onOpenChange: (o: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const years = useFiscalYears(open);
  const create = useCreateBudget();
  const update = useUpdateBudget();
  const defaults = React.useCallback(
    (): BudgetFormInput => ({
      fiscalYearId: budget?.fiscalYearId ?? '',
      code: budget?.code ?? '',
      name: budget?.name ?? '',
      description: budget?.description ?? undefined,
    }),
    [budget],
  );
  const form = useForm<BudgetFormInput, unknown, CreateBudgetInput>({
    resolver: zodResolver(createBudgetSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  React.useEffect(() => {
    if (open && !budget && !form.getValues('fiscalYearId') && years.data?.[0])
      form.setValue('fiscalYearId', years.data[0].id);
  }, [open, budget, years.data, form]);
  const submit = form.handleSubmit(async (values) => {
    try {
      if (budget) {
        const { fiscalYearId: _y, ...rest } = values;
        await update.mutateAsync({ id: budget.id, ...rest });
        toast.success('Budget updated.');
      } else {
        const created = await create.mutateAsync(values);
        toast.success(`${created.code} created with a first draft version.`);
        onCreated?.(created.id);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{budget ? `Edit ${budget.code}` : 'New budget'}</DialogTitle>
          <DialogDescription>
            A budget belongs to one fiscal year; the numbers live in versions.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <FormField
              control={form.control}
              name="fiscalYearId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fiscal year</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={Boolean(budget)}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="budget-year">
                        <SelectValue placeholder="Select year" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {years.data?.map((y) => (
                        <SelectItem key={y.id} value={y.id}>
                          {y.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        className="font-mono uppercase"
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        data-testid="budget-code"
                      />
                    </FormControl>
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
                      <Input {...field} data-testid="budget-name" />
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
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || update.isPending}
                data-testid="budget-save"
              >
                {budget ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ detail

export function BudgetDetailPage({ id }: { id: string }) {
  const { hasPermission } = useSession();
  const budget = useBudget(id);
  const [versionId, setVersionId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [newVersion, setNewVersion] = React.useState(false);
  const canManage = hasPermission(P['budget.manage']);
  const b = budget.data;
  const selected =
    b?.versions.find((v) => v.id === versionId) ??
    b?.versions.find((v) => v.status === 'APPROVED') ??
    b?.versions[0];
  if (budget.isLoading || !b) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{b.code}</span>
            <span>{b.name}</span>
            <StatusBadge tone={toneOf(STATUS_VARIANT[b.status])}>{titleCase(b.status)}</StatusBadge>
          </span>
        }
        description={`${b.fiscalYearName} · ${b.versionCount} version(s)${b.description ? ` · ${b.description}` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={BUDGETS_PATH}>
                <ArrowLeft /> Budgets
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/budgeting/variance?budgetId=${b.id}`}>Variance</Link>
            </Button>
            {canManage ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            {canManage && b.status !== 'ARCHIVED' ? (
              <Button size="sm" onClick={() => setNewVersion(true)} data-testid="new-version">
                <Plus /> New version
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Versions</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {b.versions.map((v) => (
                  <TableRow
                    key={v.id}
                    className={v.id === selected?.id ? 'bg-muted/50' : undefined}
                    onClick={() => setVersionId(v.id)}
                    data-testid="budget-version"
                  >
                    <TableCell>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          v{v.versionNumber} {v.name}
                        </span>
                        <StatusBadge tone={toneOf(VERSION_VARIANT[v.status])}>
                          {titleCase(v.status)}
                        </StatusBadge>
                      </div>
                      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                        <span>{v.lineCount} lines</span>
                        <Amount value={v.total} currency={b.currency} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        {selected ? <VersionEditor budget={b} versionId={selected.id} /> : null}
      </div>
      <BudgetDialog open={editing} budget={b} onOpenChange={setEditing} />
      <NewVersionDialog
        budget={b}
        open={newVersion}
        onOpenChange={setNewVersion}
        onCreated={setVersionId}
      />
    </>
  );
}

function NewVersionDialog({
  budget,
  open,
  onOpenChange,
  onCreated,
}: {
  budget: BudgetDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateBudgetVersion();
  const [name, setName] = React.useState('');
  const [copyFrom, setCopyFrom] = React.useState<string>('none');
  React.useEffect(() => {
    if (open) {
      setName(`Version ${budget.versions.length + 1}`);
      setCopyFrom(budget.approvedVersionId ?? 'none');
    }
  }, [open, budget]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New version</DialogTitle>
          <DialogDescription>
            Start empty or copy an existing version&apos;s lines.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="version-name"
            />
          </div>
          <div className="space-y-1">
            <Label>Copy lines from</Label>
            <Select value={copyFrom} onValueChange={setCopyFrom}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Start empty</SelectItem>
                {budget.versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    v{v.versionNumber} {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || create.isPending}
            data-testid="version-create"
            onClick={async () => {
              try {
                const v = await create.mutateAsync({
                  budgetId: budget.id,
                  name: name.trim(),
                  copyFromVersionId: copyFrom === 'none' ? undefined : copyFrom,
                });
                toast.success(`${v.name} created.`);
                onOpenChange(false);
                onCreated(v.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One row of the grid: an account (optionally per dimension) with one amount per period. */
interface GridRow {
  key: string;
  accountId: string;
  dims: DimensionRefs;
  amounts: Record<string, string>;
}

function toGrid(lines: BudgetLine[]): GridRow[] {
  const rows = new Map<string, GridRow>();
  for (const l of lines) {
    const dims = {
      departmentId: l.departmentId ?? null,
      costCenterId: l.costCenterId ?? null,
      projectId: l.projectId ?? null,
    };
    const key = [
      l.accountId,
      dims.departmentId ?? '',
      dims.costCenterId ?? '',
      dims.projectId ?? '',
    ].join('|');
    const row = rows.get(key) ?? { key, accountId: l.accountId, dims, amounts: {} };
    row.amounts[l.fiscalPeriodId] = trimAmount(l.amount);
    rows.set(key, row);
  }
  return [...rows.values()];
}

function trimAmount(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}

function VersionEditor({ budget, versionId }: { budget: BudgetDetail; versionId: string }) {
  const { hasPermission } = useSession();
  const version = useBudgetVersion(budget.id, versionId);
  const replace = useReplaceBudgetLines();
  const approve = useApproveBudgetVersion();
  const remove = useDeleteBudgetVersion();
  const [rows, setRows] = React.useState<GridRow[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const [approving, setApproving] = React.useState(false);
  React.useEffect(() => {
    if (version.data) {
      setRows(toGrid(version.data.lines));
      setDirty(false);
    }
  }, [version.data]);
  const v = version.data;
  if (!v) return <Skeleton className="h-96" />;
  const editable = v.status === 'DRAFT' && hasPermission(P['budget.manage']);
  const periods: BudgetPeriod[] = budget.periods;
  const currency = budget.currency;
  const rowTotal = (r: GridRow) =>
    Money.sum(
      periods.map((p) => Money.of(r.amounts[p.id] || '0', currency)),
      currency,
    );
  const colTotal = (p: BudgetPeriod) =>
    Money.sum(
      rows.map((r) => Money.of(r.amounts[p.id] || '0', currency)),
      currency,
    );
  const grand = Money.sum(rows.map(rowTotal), currency);
  const setCell = (key: string, periodId: string, value: string) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, amounts: { ...r.amounts, [periodId]: value } } : r)),
    );
    setDirty(true);
  };
  const spread = (key: string, value: string) => {
    if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return;
    const per = Money.of(value.trim(), currency).divide(String(periods.length));
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? {
              ...r,
              amounts: Object.fromEntries(periods.map((p) => [p.id, trimAmount(per.toString())])),
            }
          : r,
      ),
    );
    setDirty(true);
  };
  const save = async () => {
    try {
      const lines = rows.flatMap((r) =>
        periods
          .filter((p) => r.amounts[p.id] && Number(r.amounts[p.id]) !== 0)
          .map((p) => ({
            accountId: r.accountId,
            fiscalPeriodId: p.id,
            amount: r.amounts[p.id]!,
            ...r.dims,
          })),
      );
      if (lines.some((l) => !l.accountId)) throw new Error('Every row needs an account.');
      await replace.mutateAsync({ budgetId: budget.id, versionId, lines });
      toast.success('Budget lines saved.');
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            v{v.versionNumber} {v.name}{' '}
            <StatusBadge tone={toneOf(VERSION_VARIANT[v.status])}>
              {titleCase(v.status)}
            </StatusBadge>
          </CardTitle>
          <CardDescription>
            {v.status === 'APPROVED'
              ? `Approved ${formatDateTime(v.approvedAt)}. Locked; create a new version to change the numbers.`
              : v.status === 'DRAFT'
                ? "Amounts are in the account's natural direction: budgeted revenue and expense are positive."
                : 'Superseded by a later approved version.'}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          {editable ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setRows((prev) => [
                    ...prev,
                    { key: `new-${Date.now()}`, accountId: '', dims: {}, amounts: {} },
                  ])
                }
                data-testid="add-budget-row"
              >
                <Plus /> Row
              </Button>
              <Button
                size="sm"
                disabled={!dirty || replace.isPending}
                onClick={save}
                data-testid="save-budget-lines"
              >
                Save
              </Button>
              {hasPermission(P['budget.approve']) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={dirty || v.lineCount === 0}
                  onClick={() => setApproving(true)}
                  data-testid="approve-version"
                >
                  <Check /> Approve
                </Button>
              ) : null}
              {budget.versions.length > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await remove.mutateAsync({ budgetId: budget.id, versionId });
                      toast.success('Draft deleted.');
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="min-w-[260px]">Account</TableHead>
              <TableHead className="w-12" />
              {periods.map((p) => (
                <TableHead key={p.id} className="min-w-[96px] text-right text-xs">
                  {p.name.replace(/ \d{4}$/, '').slice(0, 3)}
                </TableHead>
              ))}
              <TableHead className="min-w-[120px] text-right">Total</TableHead>
              {editable ? <TableHead className="w-24" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={periods.length + 4}
                  className="py-8 text-center text-muted-foreground"
                >
                  No lines yet.{editable ? ' Add a row to start.' : ''}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.key} className="hover:bg-transparent" data-testid="budget-row">
                  <TableCell>
                    {editable ? (
                      <AccountCombobox
                        value={r.accountId || null}
                        onChange={(id) => {
                          setRows((prev) =>
                            prev.map((x) => (x.key === r.key ? { ...x, accountId: id } : x)),
                          );
                          setDirty(true);
                        }}
                        types={['REVENUE', 'EXPENSE', 'ASSET', 'LIABILITY']}
                      />
                    ) : (
                      <span>
                        <span className="mr-2 font-mono text-xs text-muted-foreground">
                          {v.lines.find((l) => l.accountId === r.accountId)?.accountCode}
                        </span>
                        {v.lines.find((l) => l.accountId === r.accountId)?.accountName}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DimensionsPopover
                      value={r.dims}
                      disabled={!editable}
                      onChange={(next) => {
                        setRows((prev) =>
                          prev.map((x) => (x.key === r.key ? { ...x, dims: next } : x)),
                        );
                        setDirty(true);
                      }}
                    />
                  </TableCell>
                  {periods.map((p) => (
                    <TableCell key={p.id} className="p-1">
                      {editable ? (
                        <Input
                          inputMode="decimal"
                          className="h-8 text-right tabular text-xs"
                          value={r.amounts[p.id] ?? ''}
                          onChange={(e) => setCell(r.key, p.id, e.target.value)}
                          aria-label={`${p.name} amount`}
                        />
                      ) : (
                        <Amount value={r.amounts[p.id] ?? '0'} zeroAsDash />
                      )}
                    </TableCell>
                  ))}
                  <TableCell>
                    <Amount
                      value={rowTotal(r).toString()}
                      currency={currency}
                      className="font-medium"
                    />
                  </TableCell>
                  {editable ? (
                    <TableCell className="whitespace-nowrap">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        title="Spread an annual amount evenly"
                        onClick={() => {
                          const v2 = window.prompt(
                            'Annual amount to spread evenly across the periods',
                          );
                          if (v2) spread(r.key, v2);
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove row"
                        onClick={() => {
                          setRows((prev) => prev.filter((x) => x.key !== r.key));
                          setDirty(true);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
          {rows.length > 0 ? (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>Total</TableCell>
                {periods.map((p) => (
                  <TableCell key={p.id} className="p-1">
                    <Amount value={colTotal(p).toString()} zeroAsDash className="text-xs" />
                  </TableCell>
                ))}
                <TableCell>
                  <Amount value={grand.toString()} currency={currency} className="font-semibold" />
                </TableCell>
                {editable ? <TableCell /> : null}
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </CardContent>
      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        title={`Approve ${v.name}?`}
        description="Locks the lines and makes this the baseline for variance analysis; the previously approved version is superseded."
        confirmLabel="Approve"
        loading={approve.isPending}
        onConfirm={async () => {
          try {
            await approve.mutateAsync({ budgetId: budget.id, versionId });
            toast.success('Version approved.');
            setApproving(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </Card>
  );
}
