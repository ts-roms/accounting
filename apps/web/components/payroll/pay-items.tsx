'use client';
import * as React from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PayBracket, PayFrequency, PayItemCalculation, PayItemType } from '@accounting/types';
import { P, PAY_FREQUENCIES, PAY_ITEM_CALCULATIONS, PAY_ITEM_TYPES } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
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
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreatePayItem,
  usePayItems,
  usePayrollSettings,
  useUpdatePayItem,
  useUpdatePayrollSettings,
} from '@/lib/api/payroll-hooks';
import type { PayItem } from '@/lib/api/payroll-types';

import { AccountCombobox } from '@/components/accounting/primitives';
import { BankAccountSelect } from '@/components/banking/shared';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { Field, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';
import { FREQUENCY_LABEL } from './employees';

export const ITEM_TYPE_LABEL: Record<PayItemType, string> = {
  EARNING: 'Earning',
  DEDUCTION: 'Deduction',
  WITHHOLDING_TAX: 'Withholding tax',
  EMPLOYER_CONTRIBUTION: 'Employer contribution',
};
const CALC_LABEL: Record<PayItemCalculation, string> = {
  FIXED: 'Fixed amount',
  PERCENT_OF_GROSS: 'Percent of gross',
  BRACKET: 'Progressive brackets',
  BASE_SALARY: 'Base salary',
};

function describeItem(i: PayItem): string {
  switch (i.calculation) {
    case 'BASE_SALARY':
      return 'employee base pay';
    case 'FIXED':
      return i.amount
        ? `${Number(i.amount).toLocaleString()} per period`
        : 'amount per assignment / input';
    case 'PERCENT_OF_GROSS':
      return `${Number(i.rate ?? 0)}% of gross${i.maxBase ? ` (capped at ${Number(i.maxBase).toLocaleString()})` : ''}`;
    case 'BRACKET':
      return `${i.brackets.length} bracket(s)`;
  }
}

/** Pay items and payroll settings: what a payslip line is, how it is computed and where it posts. */
export function PayItemsPage() {
  const items = usePayItems();
  const settings = usePayrollSettings();
  const updateSettings = useUpdatePayrollSettings();
  const [editing, setEditing] = React.useState<PayItem | 'new' | null>(null);
  const [form, setForm] = React.useState({
    defaultPayFrequency: 'MONTHLY' as PayFrequency,
    payrollBankAccountId: null as string | null,
    reimburseExpenseClaims: true,
    payDateReminderDays: '3',
  });
  React.useEffect(() => {
    if (!settings.data) return;
    setForm({
      defaultPayFrequency: settings.data.defaultPayFrequency,
      payrollBankAccountId: settings.data.payrollBankAccountId,
      reimburseExpenseClaims: settings.data.reimburseExpenseClaims,
      payDateReminderDays: String(settings.data.payDateReminderDays),
    });
  }, [settings.data]);
  return (
    <>
      <PageHeader
        title="Pay Items"
        description="Payroll policy is data: earnings, deductions, withholding brackets and employer contributions, each with its calculation and the accounts it posts to (blank = the company mappings)."
        actions={
          <Can permissions={[P['payroll.manage']]}>
            <Button size="sm" onClick={() => setEditing('new')} data-testid="pay-item-new">
              <Plus /> New pay item
            </Button>
          </Can>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Pay items</CardTitle>
            <CardDescription>
              Company-wide items apply to every employee; others need an assignment or a run input.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <QueryState query={items}>
              {(rows) => (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Calculation</TableHead>
                      <TableHead>Applies</TableHead>
                      <TableHead>Accounts</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((i) => (
                      <TableRow key={i.id} data-testid="pay-item-row">
                        <TableCell className="font-mono text-sm">{i.code}</TableCell>
                        <TableCell>
                          <div>{i.name}</div>
                          {i.type === 'EARNING' ? (
                            <div className="text-xs text-muted-foreground">
                              {i.taxable ? 'taxable' : 'non-taxable'}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>{ITEM_TYPE_LABEL[i.type]}</TableCell>
                        <TableCell>
                          <div>{CALC_LABEL[i.calculation]}</div>
                          <div className="text-xs text-muted-foreground">{describeItem(i)}</div>
                        </TableCell>
                        <TableCell>{i.appliesToAll ? 'Everyone' : 'Assigned'}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {[i.expenseAccountCode, i.liabilityAccountCode]
                            .filter(Boolean)
                            .join(' / ') || 'mapping'}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={i.status} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Can permissions={[P['payroll.manage']]}>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Edit ${i.code}`}
                              onClick={() => setEditing(i)}
                            >
                              <Pencil />
                            </Button>
                          </Can>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </QueryState>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Settings</CardTitle>
            <CardDescription>
              Default frequency, the bank account payroll is paid from, claim reimbursement and
              reminders.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <QueryState query={settings}>
              {() => (
                <>
                  <Field label="Default pay frequency">
                    <Select
                      value={form.defaultPayFrequency}
                      onValueChange={(v) =>
                        setForm((f) => ({ ...f, defaultPayFrequency: v as PayFrequency }))
                      }
                    >
                      <SelectTrigger aria-label="Default pay frequency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAY_FREQUENCIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {FREQUENCY_LABEL[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Payroll bank account">
                    <BankAccountSelect
                      value={form.payrollBankAccountId}
                      onChange={(id) => setForm((f) => ({ ...f, payrollBankAccountId: id }))}
                    />
                  </Field>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.reimburseExpenseClaims}
                      onCheckedChange={(v) =>
                        setForm((f) => ({ ...f, reimburseExpenseClaims: v === true }))
                      }
                      aria-label="Reimburse expense claims"
                    />
                    Reimburse posted expense claims through pay runs
                  </label>
                  <Field label="Pay date reminder (days before)">
                    <Input
                      inputMode="numeric"
                      value={form.payDateReminderDays}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, payDateReminderDays: e.target.value }))
                      }
                    />
                  </Field>
                  <Can permissions={[P['payroll.manage']]}>
                    <Button
                      size="sm"
                      disabled={updateSettings.isPending}
                      onClick={async () => {
                        try {
                          await updateSettings.mutateAsync({
                            ...form,
                            payDateReminderDays: Number(form.payDateReminderDays || 0),
                          });
                          toast.success('Payroll settings saved');
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      Save settings
                    </Button>
                  </Can>
                </>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </div>
      <PayItemDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function PayItemDialog({
  editing,
  onClose,
}: {
  editing: PayItem | 'new' | null;
  onClose: () => void;
}) {
  const create = useCreatePayItem();
  const update = useUpdatePayItem();
  const isNew = editing === 'new';
  const existing = editing && editing !== 'new' ? editing : null;
  const [form, setForm] = React.useState({
    code: '',
    name: '',
    type: 'EARNING' as PayItemType,
    calculation: 'FIXED' as PayItemCalculation,
    description: '',
    amount: '',
    rate: '',
    maxBase: '',
    brackets: [] as PayBracket[],
    taxable: true,
    appliesToAll: false,
    expenseAccountId: null as string | null,
    liabilityAccountId: null as string | null,
    sortOrder: '100',
    status: 'ACTIVE',
  });
  React.useEffect(() => {
    if (!editing) return;
    setForm({
      code: existing?.code ?? '',
      name: existing?.name ?? '',
      type: existing?.type ?? 'EARNING',
      calculation: existing?.calculation ?? 'FIXED',
      description: existing?.description ?? '',
      amount: existing?.amount ? String(Number(existing.amount)) : '',
      rate: existing?.rate ? String(Number(existing.rate)) : '',
      maxBase: existing?.maxBase ? String(Number(existing.maxBase)) : '',
      brackets: existing?.brackets ?? [],
      taxable: existing?.taxable ?? true,
      appliesToAll: existing?.appliesToAll ?? false,
      expenseAccountId: existing?.expenseAccountId ?? null,
      liabilityAccountId: existing?.liabilityAccountId ?? null,
      sortOrder: String(existing?.sortOrder ?? 100),
      status: existing?.status ?? 'ACTIVE',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const pending = create.isPending || update.isPending;
  const needsExpense = form.type === 'EARNING' || form.type === 'EMPLOYER_CONTRIBUTION';
  const needsLiability = form.type !== 'EARNING';
  const submit = async () => {
    const common = {
      name: form.name,
      description: form.description || undefined,
      amount: form.amount || null,
      rate: form.rate || null,
      maxBase: form.maxBase || null,
      brackets: form.calculation === 'BRACKET' ? form.brackets : undefined,
      taxable: form.taxable,
      appliesToAll: form.appliesToAll,
      expenseAccountId: form.expenseAccountId,
      liabilityAccountId: form.liabilityAccountId,
      sortOrder: Number(form.sortOrder || 100),
    };
    try {
      if (isNew)
        await create.mutateAsync({
          code: form.code,
          type: form.type,
          calculation: form.calculation,
          ...common,
        });
      else if (existing)
        await update.mutateAsync({
          id: existing.id,
          ...common,
          status: form.status as PayItem['status'],
        });
      toast.success(isNew ? 'Pay item created' : 'Pay item updated');
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const setBracket = (i: number, patch: Partial<PayBracket>) =>
    setForm((f) => ({
      ...f,
      brackets: f.brackets.map((b, j) => (j === i ? { ...b, ...patch } : b)),
    }));
  return (
    <Dialog open={Boolean(editing)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New pay item' : `Edit ${existing?.code}`}</DialogTitle>
          <DialogDescription>
            Type and calculation are fixed once created; amounts, rates, brackets and accounts can
            change.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={form.code}
              disabled={!isNew}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              data-testid="pay-item-code"
            />
          </Field>
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              data-testid="pay-item-name"
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.type}
              disabled={!isNew}
              onValueChange={(v) => setForm((f) => ({ ...f, type: v as PayItemType }))}
            >
              <SelectTrigger aria-label="Type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAY_ITEM_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ITEM_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Calculation">
            <Select
              value={form.calculation}
              disabled={!isNew}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, calculation: v as PayItemCalculation }))
              }
            >
              <SelectTrigger aria-label="Calculation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAY_ITEM_CALCULATIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CALC_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {form.calculation === 'FIXED' ? (
            <Field label="Default amount per period" hint="Blank = set per employee or per run">
              <Input
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                data-testid="pay-item-amount"
              />
            </Field>
          ) : null}
          {form.calculation === 'PERCENT_OF_GROSS' ? (
            <>
              <Field label="Rate (%)">
                <Input
                  inputMode="decimal"
                  value={form.rate}
                  onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                />
              </Field>
              <Field label="Maximum base" hint="Blank = no cap">
                <Input
                  inputMode="decimal"
                  value={form.maxBase}
                  onChange={(e) => setForm((f) => ({ ...f, maxBase: e.target.value }))}
                />
              </Field>
            </>
          ) : null}
          {form.calculation === 'BRACKET' ? (
            <div className="space-y-2 sm:col-span-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  Brackets (taxable pay per period above &quot;over&quot;: base + rate% of the
                  excess)
                </Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      brackets: [...f.brackets, { over: '', base: '', rate: '' }],
                    }))
                  }
                >
                  <Plus /> Bracket
                </Button>
              </div>
              {form.brackets.map((b, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_5rem_auto] items-center gap-1">
                  <Input
                    className="h-8"
                    placeholder="Over"
                    inputMode="decimal"
                    value={b.over}
                    onChange={(e) => setBracket(i, { over: e.target.value })}
                  />
                  <Input
                    className="h-8"
                    placeholder="Base tax"
                    inputMode="decimal"
                    value={b.base}
                    onChange={(e) => setBracket(i, { base: e.target.value })}
                  />
                  <Input
                    className="h-8"
                    placeholder="%"
                    inputMode="decimal"
                    value={b.rate}
                    onChange={(e) => setBracket(i, { rate: e.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove bracket"
                    onClick={() =>
                      setForm((f) => ({ ...f, brackets: f.brackets.filter((_, j) => j !== i) }))
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          {needsExpense ? (
            <Field
              label="Expense account"
              hint="Blank = SALARY_EXPENSE / EMPLOYER_CONTRIBUTION_EXPENSE mapping"
            >
              <AccountCombobox
                value={form.expenseAccountId}
                onChange={(id) => setForm((f) => ({ ...f, expenseAccountId: id }))}
                types={['EXPENSE']}
              />
            </Field>
          ) : null}
          {needsLiability ? (
            <Field label="Liability account" hint="Blank = statutory / withholding payable mapping">
              <AccountCombobox
                value={form.liabilityAccountId}
                onChange={(id) => setForm((f) => ({ ...f, liabilityAccountId: id }))}
                types={['LIABILITY']}
              />
            </Field>
          ) : null}
          <Field label="Sort order">
            <Input
              inputMode="numeric"
              value={form.sortOrder}
              onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
            />
          </Field>
          {!isNew ? (
            <Field label="Status">
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}
              >
                <SelectTrigger aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </Field>
          </div>
          {form.type === 'EARNING' && form.calculation !== 'BASE_SALARY' ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.taxable}
                onCheckedChange={(v) => setForm((f) => ({ ...f, taxable: v === true }))}
              />{' '}
              Taxable
            </label>
          ) : null}
          {form.calculation !== 'BASE_SALARY' ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.appliesToAll}
                onCheckedChange={(v) => setForm((f) => ({ ...f, appliesToAll: v === true }))}
              />{' '}
              Applies to every employee
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !form.name || (isNew && !form.code)}
            data-testid="pay-item-save"
          >
            {isNew ? 'Create pay item' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
