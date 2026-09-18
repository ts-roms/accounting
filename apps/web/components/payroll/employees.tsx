'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { EmployeePaymentMethod, EmploymentType, PayFrequency } from '@accounting/types';
import {
  EMPLOYEE_PAYMENT_METHODS,
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  P,
  PAY_FREQUENCIES,
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
  DialogDescription,
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
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAssignPayItem,
  useCreateEmployee,
  useEmployee,
  useEmployeeYtd,
  useEmployees,
  usePayItems,
  useRemovePayItemAssignment,
  useUpdateEmployee,
} from '@/lib/api/payroll-hooks';
import type { Employee, EmployeeDetail } from '@/lib/api/payroll-types';
import { formatDate, titleCase } from '@/lib/format';
import { Amount, today } from '@/components/accounting/primitives';
import { DimensionSelect } from '@/components/dimensions/pickers';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Field, Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';

export const FREQUENCY_LABEL: Record<PayFrequency, string> = {
  MONTHLY: 'Monthly',
  SEMI_MONTHLY: 'Semi-monthly',
  WEEKLY: 'Weekly',
};

export function EmployeesPage() {
  const router = useAppRouter();
  const table = useTableState();
  const [status, setStatus] = React.useState('ACTIVE');
  const [creating, setCreating] = React.useState(false);
  const employees = useEmployees({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as Employee['status']),
  });
  const columns = React.useMemo<ColumnDef<Employee>[]>(
    () => [
      {
        id: 'number',
        header: 'Employee',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="text-sm">{row.original.fullName}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {row.original.employeeNumber}
              {row.original.jobTitle ? ` - ${row.original.jobTitle}` : ''}
            </div>
          </div>
        ),
      },
      {
        id: 'department',
        header: 'Department',
        enableSorting: false,
        cell: ({ row }) => row.original.departmentName ?? '-',
      },
      {
        id: 'frequency',
        header: 'Pay frequency',
        enableSorting: false,
        cell: ({ row }) => FREQUENCY_LABEL[row.original.payFrequency],
      },
      {
        id: 'salary',
        header: () => <span className="block text-right">Base pay</span>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.baseSalary} />,
      },
      {
        id: 'hired',
        header: 'Hired',
        enableSorting: false,
        cell: ({ row }) => formatDate(row.original.hireDate),
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
        title="Employees"
        description="Payroll master data: pay frequency, base pay, department and bank details. Link an employee to their user so posted expense claims can be reimbursed through payroll."
        actions={
          <Can permissions={[P['employee.manage']]}>
            <Button size="sm" onClick={() => setCreating(true)} data-testid="employee-new">
              <Plus /> New employee
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={employees.data}
        isLoading={employees.isLoading}
        isFetching={employees.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`/payroll/employees/${r.id}`)}
        emptyState={
          <EmptyState
            icon={Users}
            title="No employees"
            description="Add your first employee to run payroll."
          />
        }
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Number, name, email"
                className="w-64 pl-8"
                aria-label="Search employees"
              />
            </div>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {EMPLOYEE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <EmployeeDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

// ----------------------------------------------------------------- detail

export function EmployeeDetailPage({ id }: { id: string }) {
  const employee = useEmployee(id);
  const ytd = useEmployeeYtd(id);
  const remove = useRemovePayItemAssignment();
  const [editing, setEditing] = React.useState(false);
  const [assigning, setAssigning] = React.useState(false);
  return (
    <QueryState query={employee}>
      {(e) => (
        <>
          <PageHeader
            eyebrow={
              <Link href="/payroll/employees" className="inline-flex items-center gap-1 text-xs">
                <ArrowLeft className="h-3 w-3" /> Employees
              </Link>
            }
            title={e.fullName}
            description={
              <span className="flex flex-wrap items-center gap-2">
                <StatusBadge status={e.status} /> {e.employeeNumber}
                {e.jobTitle ? ` - ${e.jobTitle}` : ''} - {FREQUENCY_LABEL[e.payFrequency]} - hired{' '}
                {formatDate(e.hireDate)}
                {e.userEmail ? ` - user ${e.userEmail}` : ''}
              </span>
            }
            actions={
              <Can permissions={[P['employee.manage']]}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(true)}
                  data-testid="employee-edit"
                >
                  <Pencil /> Edit
                </Button>
              </Can>
            }
          />
          <div className="grid gap-3 sm:grid-cols-4">
            <Kpi
              label={`Base pay (${FREQUENCY_LABEL[e.payFrequency].toLowerCase()})`}
              value={e.baseSalary}
            />
            <Kpi
              label={`YTD gross ${ytd.data?.year ?? ''}`}
              value={ytd.data?.gross ?? '0'}
              hint={`${ytd.data?.payslips ?? 0} payslip(s)`}
            />
            <Kpi label="YTD withholding" value={ytd.data?.withholding ?? '0'} />
            <Kpi label="YTD net" value={ytd.data?.net ?? '0'} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Recurring pay items</CardTitle>
                <CardDescription>
                  Allowances, loans and opt-in contributions applied in every run of their effective
                  window.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Amount / rate</TableHead>
                      <TableHead>Effective</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {e.payItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                          Only company-wide items apply.
                        </TableCell>
                      </TableRow>
                    ) : (
                      e.payItems.map((a) => (
                        <TableRow key={a.id} data-testid="employee-pay-item">
                          <TableCell>
                            <div>{a.payItemName}</div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {a.payItemCode} - {titleCase(a.payItemType)}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {a.amount ? (
                              <Amount value={a.amount} />
                            ) : a.rate ? (
                              `${Number(a.rate)}%`
                            ) : (
                              'item default'
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {formatDate(a.effectiveFrom)}
                            {a.effectiveTo ? ` - ${formatDate(a.effectiveTo)}` : ' onwards'}
                            {a.notes ? (
                              <div className="text-muted-foreground">{a.notes}</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">
                            <Can permissions={[P['employee.manage']]}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Remove"
                                onClick={async () => {
                                  try {
                                    await remove.mutateAsync({
                                      employeeId: e.id,
                                      assignmentId: a.id,
                                    });
                                  } catch (err) {
                                    toast.error(describeError(err));
                                  }
                                }}
                              >
                                <Trash2 />
                              </Button>
                            </Can>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                <Can permissions={[P['employee.manage']]}>
                  <div className="p-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAssigning(true)}
                      data-testid="employee-assign"
                    >
                      <Plus /> Assign pay item
                    </Button>
                  </div>
                </Can>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Details</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
                <Detail label="Employment" value={titleCase(e.employmentType)} />
                <Detail label="Department" value={e.departmentName ?? '-'} />
                <Detail label="Email" value={e.email ?? '-'} />
                <Detail label="TIN" value={e.taxIdentificationNumber ?? '-'} />
                <Detail
                  label="Payment"
                  value={`${titleCase(e.paymentMethod)}${e.bankName ? ` - ${e.bankName} ${e.bankAccountNumber ?? ''}` : ''}`}
                />
                <Detail
                  label="Termination"
                  value={e.terminationDate ? formatDate(e.terminationDate) : '-'}
                />
                {ytd.data?.byItem.length ? (
                  <div className="sm:col-span-2">
                    <div className="type-label mb-1">Year-to-date by item</div>
                    {ytd.data.byItem.map((i) => (
                      <div key={i.code} className="flex justify-between text-xs">
                        <span>{i.code}</span>
                        <span className="tabular">{i.amount}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
          <EmployeeDialog open={editing} onClose={() => setEditing(false)} existing={e} />
          <AssignDialog open={assigning} onClose={() => setAssigning(false)} employee={e} />
        </>
      )}
    </QueryState>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------- dialogs

function EmployeeDialog({
  open,
  onClose,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  existing?: EmployeeDetail;
}) {
  const create = useCreateEmployee();
  const update = useUpdateEmployee();
  const [form, setForm] = React.useState({
    firstName: '',
    lastName: '',
    email: '',
    jobTitle: '',
    employmentType: 'FULL_TIME' as EmploymentType,
    payFrequency: 'MONTHLY' as PayFrequency,
    currency: '',
    baseSalary: '',
    hireDate: today(),
    terminationDate: '',
    departmentId: null as string | null,
    taxIdentificationNumber: '',
    paymentMethod: 'BANK' as EmployeePaymentMethod,
    bankName: '',
    bankAccountNumber: '',
    changeReason: '',
  });
  React.useEffect(() => {
    if (!open) return;
    setForm({
      firstName: existing?.firstName ?? '',
      lastName: existing?.lastName ?? '',
      email: existing?.email ?? '',
      jobTitle: existing?.jobTitle ?? '',
      employmentType: existing?.employmentType ?? 'FULL_TIME',
      payFrequency: existing?.payFrequency ?? 'MONTHLY',
      currency: existing?.currency ?? '',
      baseSalary: existing ? String(Number(existing.baseSalary)) : '',
      hireDate: existing?.hireDate ?? today(),
      terminationDate: existing?.terminationDate ?? '',
      departmentId: existing?.departmentId ?? null,
      taxIdentificationNumber: existing?.taxIdentificationNumber ?? '',
      paymentMethod: existing?.paymentMethod ?? 'BANK',
      bankName: existing?.bankName ?? '',
      bankAccountNumber: existing?.bankAccountNumber ?? '',
      changeReason: '',
    });
  }, [open, existing]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const pending = create.isPending || update.isPending;
  const submit = async () => {
    const payload = {
      firstName: form.firstName,
      lastName: form.lastName,
      email: form.email || null,
      jobTitle: form.jobTitle || undefined,
      employmentType: form.employmentType,
      payFrequency: form.payFrequency,
      currency: form.currency.trim() ? form.currency.trim().toUpperCase() : undefined,
      baseSalary: form.baseSalary,
      hireDate: form.hireDate,
      terminationDate: form.terminationDate || null,
      departmentId: form.departmentId,
      taxIdentificationNumber: form.taxIdentificationNumber || undefined,
      paymentMethod: form.paymentMethod,
      bankName: form.bankName || undefined,
      bankAccountNumber: form.bankAccountNumber || undefined,
    };
    try {
      if (existing)
        await update.mutateAsync({
          id: existing.id,
          ...payload,
          changeReason: form.changeReason || undefined,
        });
      else await create.mutateAsync(payload);
      toast.success(existing ? 'Employee updated' : 'Employee created');
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.employeeNumber}` : 'New employee'}</DialogTitle>
          <DialogDescription>
            Base pay is per pay period in the company currency; the employee number comes from the
            EMP numbering rule.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name">
            <Input
              value={form.firstName}
              onChange={set('firstName')}
              data-testid="employee-first-name"
            />
          </Field>
          <Field label="Last name">
            <Input
              value={form.lastName}
              onChange={set('lastName')}
              data-testid="employee-last-name"
            />
          </Field>
          <Field label="Job title">
            <Input value={form.jobTitle} onChange={set('jobTitle')} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={set('email')} />
          </Field>
          <Field label="Employment type">
            <Select
              value={form.employmentType}
              onValueChange={(v) => setForm((f) => ({ ...f, employmentType: v as EmploymentType }))}
            >
              <SelectTrigger aria-label="Employment type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Pay frequency">
            <Select
              value={form.payFrequency}
              onValueChange={(v) => setForm((f) => ({ ...f, payFrequency: v as PayFrequency }))}
            >
              <SelectTrigger aria-label="Pay frequency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAY_FREQUENCIES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {FREQUENCY_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Base pay per period">
            <Input
              inputMode="decimal"
              value={form.baseSalary}
              onChange={set('baseSalary')}
              data-testid="employee-salary"
            />
          </Field>
          <Field label="Pay currency">
            <Input
              placeholder="Company base"
              maxLength={3}
              className="font-mono uppercase"
              value={form.currency}
              onChange={set('currency')}
              data-testid="employee-currency"
            />
          </Field>
          <Field label="Department">
            <DimensionSelect
              type="DEPARTMENT"
              value={form.departmentId}
              onChange={(id) => setForm((f) => ({ ...f, departmentId: id }))}
            />
          </Field>
          <Field label="Hire date">
            <Input type="date" value={form.hireDate} onChange={set('hireDate')} />
          </Field>
          <Field label="Termination date">
            <Input type="date" value={form.terminationDate} onChange={set('terminationDate')} />
          </Field>
          <Field label="Tax identification number">
            <Input value={form.taxIdentificationNumber} onChange={set('taxIdentificationNumber')} />
          </Field>
          <Field label="Payment method">
            <Select
              value={form.paymentMethod}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, paymentMethod: v as EmployeePaymentMethod }))
              }
            >
              <SelectTrigger aria-label="Payment method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMPLOYEE_PAYMENT_METHODS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Bank">
            <Input value={form.bankName} onChange={set('bankName')} />
          </Field>
          <Field label="Bank account number">
            <Input value={form.bankAccountNumber} onChange={set('bankAccountNumber')} />
          </Field>
          {existing ? (
            <div className="sm:col-span-2">
              <Field label="Reason for change">
                <Textarea
                  rows={2}
                  value={form.changeReason}
                  onChange={(e) => setForm((f) => ({ ...f, changeReason: e.target.value }))}
                />
              </Field>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !form.firstName || !form.lastName || !form.baseSalary}
            data-testid="employee-save"
          >
            {existing ? 'Save changes' : 'Create employee'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({
  open,
  onClose,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employee: EmployeeDetail;
}) {
  const items = usePayItems();
  const assign = useAssignPayItem();
  const [form, setForm] = React.useState({
    payItemId: '',
    amount: '',
    rate: '',
    effectiveFrom: today(),
    effectiveTo: '',
    notes: '',
  });
  React.useEffect(() => {
    if (open)
      setForm({
        payItemId: '',
        amount: '',
        rate: '',
        effectiveFrom: today(),
        effectiveTo: '',
        notes: '',
      });
  }, [open]);
  const candidates = (items.data ?? []).filter(
    (i) => i.status === 'ACTIVE' && i.calculation !== 'BASE_SALARY',
  );
  const chosen = candidates.find((i) => i.id === form.payItemId);
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign pay item to {employee.fullName}</DialogTitle>
          <DialogDescription>
            Overrides the item&apos;s default for this employee within the effective window.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Pay item">
              <Select
                value={form.payItemId}
                onValueChange={(v) => setForm((f) => ({ ...f, payItemId: v }))}
              >
                <SelectTrigger aria-label="Pay item" data-testid="assign-item">
                  <SelectValue placeholder="Choose an item" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.code} - {i.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {chosen?.calculation === 'PERCENT_OF_GROSS' ? (
            <Field label="Rate (%)">
              <Input
                inputMode="decimal"
                value={form.rate}
                onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
              />
            </Field>
          ) : (
            <Field label="Amount per period">
              <Input
                inputMode="decimal"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                data-testid="assign-amount"
              />
            </Field>
          )}
          <Field label="Effective from">
            <Input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
            />
          </Field>
          <Field label="Effective to">
            <Input
              type="date"
              value={form.effectiveTo}
              onChange={(e) => setForm((f) => ({ ...f, effectiveTo: e.target.value }))}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Input
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={assign.isPending}>
            Cancel
          </Button>
          <Button
            disabled={assign.isPending || !form.payItemId}
            data-testid="assign-save"
            onClick={async () => {
              try {
                await assign.mutateAsync({
                  employeeId: employee.id,
                  payItemId: form.payItemId,
                  amount: form.amount || null,
                  rate: form.rate || null,
                  effectiveFrom: form.effectiveFrom,
                  effectiveTo: form.effectiveTo || null,
                  notes: form.notes || undefined,
                });
                toast.success('Pay item assigned');
                onClose();
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
