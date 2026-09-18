'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Coins, Plus, Trash2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Money, formatMoney } from '@accounting/money';
import { P, PETTY_CASH_VOUCHER_STATUSES } from '@accounting/types';
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useBankAccounts } from '@/lib/api/assets-banking-hooks';
import { useUsers } from '@/lib/api/hooks';
import {
  useCreatePettyCashFund,
  useCreatePettyCashVoucher,
  usePettyCashFunds,
  usePettyCashVoucher,
  usePettyCashVoucherAction,
  usePettyCashVouchers,
  useReplenishPettyCash,
} from '@/lib/api/treasury-hooks';
import type { PettyCashFund, PettyCashVoucher } from '@/lib/api/treasury-types';
import { formatDateTime, titleCase } from '@/lib/format';
import {
  APPROVAL_STEPS,
  OperationDialog,
  POSTING_STEPS,
} from '@/components/accounting/operation-dialog';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { DescriptionList, Field, ReasonDialog, StatusBadge } from '@/components/receivables/shared';

/** Imprest petty cash: funds on their own cash account, vouchers Dr expense / Cr fund, replenishment from a bank account. */
export function PettyCashPage() {
  const funds = usePettyCashFunds();
  const table = useTableState({ sortDir: 'desc' });
  const [fundId, setFundId] = React.useState('ALL');
  const [status, setStatus] = React.useState('ALL');
  const [newVoucher, setNewVoucher] = React.useState(false);
  const [newFund, setNewFund] = React.useState(false);
  const [replenish, setReplenish] = React.useState<PettyCashFund | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const vouchers = usePettyCashVouchers({
    ...table.query,
    fundId: fundId === 'ALL' ? undefined : fundId,
    status: status === 'ALL' ? undefined : (status as PettyCashVoucher['status']),
  });
  const columns = React.useMemo<ColumnDef<PettyCashVoucher>[]>(
    () => [
      {
        id: 'number',
        header: 'Voucher',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div className="font-mono text-sm">{row.original.documentNumber}</div>
            <div className="truncate text-xs text-muted-foreground">{row.original.fundCode}</div>
          </div>
        ),
      },
      {
        id: 'date',
        header: 'Date',
        enableSorting: false,
        cell: ({ row }) => row.original.voucherDate,
      },
      {
        id: 'payee',
        header: 'Payee',
        enableSorting: false,
        cell: ({ row }) => (
          <div>
            <div>{row.original.payee}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.original.description ?? row.original.receiptReference ?? ''}
            </div>
          </div>
        ),
      },
      {
        id: 'total',
        header: () => <div className="text-right">Amount</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.total} />,
      },
      {
        id: 'reimbursed',
        header: 'Reimbursed',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.status === 'POSTED'
            ? row.original.replenishmentId
              ? 'Yes'
              : 'Not yet'
            : '-',
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
        title="Petty Cash"
        description="Each fund is an imprest on its own cash-on-hand account. Vouchers post Dr expense / Cr fund; replenishing withdraws the spent amount from the bank back into the fund."
        actions={
          <>
            <Can permissions={[P['treasury-settings.manage']]}>
              <Button size="sm" variant="outline" onClick={() => setNewFund(true)}>
                <Wallet /> New fund
              </Button>
            </Can>
            <Can permissions={[P['petty-cash.manage']]}>
              <Button size="sm" onClick={() => setNewVoucher(true)} disabled={!funds.data?.length}>
                <Plus /> New voucher
              </Button>
            </Can>
          </>
        }
      />
      {!funds.data ? (
        <Skeleton className="h-40" />
      ) : funds.data.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {funds.data.map((f) => (
            <Card key={f.id} className={f.replenishmentDue ? 'border-warning/60' : undefined}>
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-sm">
                    {f.code} {f.name}
                  </CardTitle>
                  <CardDescription>
                    {f.glAccountCode} - custodian {f.custodianName ?? '-'}
                  </CardDescription>
                </div>
                <StatusBadge status={f.replenishmentDue ? 'WARNING' : f.status} />
              </CardHeader>
              <CardContent className="space-y-3">
                <DescriptionList
                  items={[
                    ['Imprest', formatMoney(f.imprestAmount, f.currency)],
                    ['Expected on hand', formatMoney(f.expectedCashOnHand, f.currency)],
                    ['Book balance (GL)', formatMoney(f.bookBalance, f.currency)],
                    [
                      'Unreimbursed vouchers',
                      `${formatMoney(f.unreplenished, f.currency)} (${f.unreplenishedCount})`,
                    ],
                    ['Pending vouchers', String(f.draftCount)],
                    ['Replenish at', `${Number(f.replenishAtPercent)}% of imprest`],
                    ['Last replenished', f.lastReplenishedAt ?? '-'],
                  ]}
                />
                <Can permissions={[P['petty-cash.post']]}>
                  <Button
                    size="sm"
                    variant={f.replenishmentDue ? 'default' : 'outline'}
                    disabled={f.status !== 'ACTIVE'}
                    onClick={() => setReplenish(f)}
                  >
                    <Coins /> Replenish{' '}
                    {Number(f.unreplenished) ? formatMoney(f.unreplenished, f.currency) : ''}
                  </Button>
                </Can>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Wallet}
          title="No petty cash funds"
          description="Create a fund on a dedicated cash-on-hand account and name its custodian."
        />
      )}
      <DataTable
        columns={columns}
        data={vouchers.data}
        isLoading={vouchers.isLoading}
        isFetching={vouchers.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        onRowClick={(r) => setSelected(r.id)}
        emptyState={
          <EmptyState
            icon={Coins}
            title="No vouchers"
            description="Record small cash disbursements against a fund."
          />
        }
        toolbar={
          <div className="flex gap-2">
            <Select
              value={fundId}
              onValueChange={(v) => {
                setFundId(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All funds</SelectItem>
                {(funds.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                {PETTY_CASH_VOUCHER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <NewVoucherDialog
        open={newVoucher}
        onOpenChange={setNewVoucher}
        funds={funds.data ?? []}
        onCreated={setSelected}
      />
      <NewFundDialog open={newFund} onOpenChange={setNewFund} />
      <ReplenishDialog fund={replenish} onOpenChange={(o) => !o && setReplenish(null)} />
      <VoucherDialog id={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </>
  );
}

// ----------------------------------------------------------------- dialogs

interface LineDraft {
  description: string;
  accountId: string | null;
  amount: string;
}

function NewVoucherDialog({
  open,
  onOpenChange,
  funds,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  funds: PettyCashFund[];
  onCreated: (id: string) => void;
}) {
  const create = useCreatePettyCashVoucher();
  const [fundId, setFundId] = React.useState('');
  const [voucherDate, setDate] = React.useState(today());
  const [payee, setPayee] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [receipt, setReceipt] = React.useState('');
  const [lines, setLines] = React.useState<LineDraft[]>([
    { description: '', accountId: null, amount: '' },
  ]);
  const fund = funds.find((f) => f.id === fundId) ?? funds[0];
  const total = lines.reduce(
    (m, l) =>
      l.amount && !Number.isNaN(Number(l.amount))
        ? m.add(Money.parse(l.amount, fund?.currency ?? 'PHP'))
        : m,
    Money.zero(fund?.currency ?? 'PHP'),
  );
  const valid =
    fund &&
    payee &&
    lines.length &&
    lines.every((l) => l.description && l.accountId && Number(l.amount) > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Petty cash voucher</DialogTitle>
          <DialogDescription>
            A voucher may not exceed the cash expected in the fund
            {fund
              ? ` (${formatMoney(fund.expectedCashOnHand, fund.currency)} in ${fund.code})`
              : ''}
            . It posts only after approval.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fund">
            <Select value={fund?.id ?? ''} onValueChange={setFundId}>
              <SelectTrigger aria-label="Fund">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {funds.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.code} {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Date">
            <Input type="date" value={voucherDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Payee">
            <Input value={payee} onChange={(e) => setPayee(e.target.value)} aria-label="Payee" />
          </Field>
          <Field label="Receipt / OR number">
            <Input value={receipt} onChange={(e) => setReceipt(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1.2fr_8rem_2.5rem]">
              <Input
                placeholder="Line description"
                value={l.description}
                onChange={(e) =>
                  setLines((p) =>
                    p.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)),
                  )
                }
                aria-label={`Line ${i + 1} description`}
              />
              <AccountCombobox
                value={l.accountId}
                onChange={(id) =>
                  setLines((p) => p.map((x, j) => (j === i ? { ...x, accountId: id } : x)))
                }
                types={['EXPENSE', 'ASSET']}
              />
              <Input
                inputMode="decimal"
                placeholder="Amount"
                value={l.amount}
                onChange={(e) =>
                  setLines((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                }
                aria-label={`Line ${i + 1} amount`}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove line"
                disabled={lines.length === 1}
                onClick={() => setLines((p) => p.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setLines((p) => [...p, { description: '', accountId: null, amount: '' }])
              }
            >
              <Plus /> Line
            </Button>
            <span className="text-sm">
              Total <strong>{formatMoney(total.toString(), fund?.currency)}</strong>
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!valid || create.isPending}
            onClick={async () => {
              try {
                const v = await create.mutateAsync({
                  fundId: fund!.id,
                  voucherDate,
                  payee,
                  description: description || undefined,
                  receiptReference: receipt || undefined,
                  lines: lines.map((l) => ({
                    description: l.description,
                    accountId: l.accountId!,
                    amount: l.amount,
                  })),
                });
                toast.success(
                  `${v.documentNumber} drafted for ${formatMoney(v.total, fund!.currency)}.`,
                );
                onOpenChange(false);
                setPayee('');
                setDescription('');
                setReceipt('');
                setLines([{ description: '', accountId: null, amount: '' }]);
                onCreated(v.id);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create voucher
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewFundDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreatePettyCashFund();
  const users = useUsers({ pageSize: 100 });
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [glAccountId, setGl] = React.useState<string | null>(null);
  const [imprest, setImprest] = React.useState('');
  const [custodianId, setCustodian] = React.useState('');
  const [limit, setLimit] = React.useState('');
  const [percent, setPercent] = React.useState('25');
  const [notes, setNotes] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New petty cash fund</DialogTitle>
          <DialogDescription>
            The GL account must be a dedicated cash-on-hand account; fund it with a bank withdrawal
            (the replenish action) once created.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="PCF-WH"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Cash account">
              <AccountCombobox value={glAccountId} onChange={setGl} types={['ASSET']} />
            </Field>
          </div>
          <Field label="Imprest amount">
            <Input
              inputMode="decimal"
              value={imprest}
              onChange={(e) => setImprest(e.target.value)}
            />
          </Field>
          <Field label="Custodian">
            <Select value={custodianId} onValueChange={setCustodian}>
              <SelectTrigger aria-label="Custodian">
                <SelectValue placeholder="User" />
              </SelectTrigger>
              <SelectContent>
                {(users.data?.items ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.firstName} {u.lastName} ({u.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Voucher approval limit"
            hint="Above this the approver must differ from the preparer"
          >
            <Input
              inputMode="decimal"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="Company default"
            />
          </Field>
          <Field label="Replenish at (% of imprest)">
            <Input
              inputMode="decimal"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !code || !name || !glAccountId || !imprest || !custodianId || create.isPending
            }
            onClick={async () => {
              try {
                const f = await create.mutateAsync({
                  code,
                  name,
                  glAccountId: glAccountId!,
                  imprestAmount: imprest,
                  custodianId,
                  voucherApprovalLimit: limit || null,
                  replenishAtPercent: percent || undefined,
                  notes: notes || undefined,
                });
                toast.success(`Fund ${f.code} created.`);
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Create fund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplenishDialog({
  fund,
  onOpenChange,
}: {
  fund: PettyCashFund | null;
  onOpenChange: (o: boolean) => void;
}) {
  const replenish = useReplenishPettyCash();
  const banks = useBankAccounts();
  const [bankAccountId, setBank] = React.useState('');
  const [date, setDate] = React.useState(today());
  const [amount, setAmount] = React.useState('');
  const [reference, setReference] = React.useState('');
  const run = () =>
    replenish.mutateAsync({
      id: fund!.id,
      bankAccountId,
      replenishmentDate: date,
      amount: amount || undefined,
      reference: reference || undefined,
    });
  return (
    <OperationDialog
      open={Boolean(fund)}
      onOpenChange={onOpenChange}
      title={fund ? `Replenish ${fund.code}` : ''}
      description={
        fund
          ? `Posts a bank withdrawal: Dr ${fund.glAccountCode} / Cr the bank account for ${amount ? formatMoney(amount, fund.currency) : formatMoney(fund.unreplenished, fund.currency)}, and marks the posted vouchers reimbursed.`
          : undefined
      }
      confirmLabel="Replenish"
      loadingLabel="Posting..."
      resultLabel="Replenished"
      steps={POSTING_STEPS}
      run={run}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="From bank account">
            <Select value={bankAccountId} onValueChange={setBank}>
              <SelectTrigger aria-label="Bank account">
                <SelectValue placeholder="Bank account" />
              </SelectTrigger>
              <SelectContent>
                {(banks.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.code} {b.name} -{' '}
                    {formatMoney(b.foreignBalance ?? b.ledgerBalance, b.currency)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field
          label="Amount"
          hint={
            fund
              ? `Blank = unreimbursed vouchers (${formatMoney(fund.unreplenished, fund.currency)})`
              : undefined
          }
        >
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Reference">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
      </div>
    </OperationDialog>
  );
}

function VoucherDialog({
  id,
  onOpenChange,
}: {
  id: string | null;
  onOpenChange: (o: boolean) => void;
}) {
  const voucher = usePettyCashVoucher(id);
  const action = usePettyCashVoucherAction();
  const [pending, setPending] = React.useState<'approve' | 'post' | 'void' | null>(null);
  const v = voucher.data;
  return (
    <>
      <Dialog open={Boolean(id) && !pending} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          {!v ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {v.documentNumber} <StatusBadge status={v.status} />
                </DialogTitle>
                <DialogDescription>
                  {v.fundCode} {v.fundName} - {v.voucherDate} - {v.payee}
                </DialogDescription>
              </DialogHeader>
              <DescriptionList
                items={[
                  ['Description', v.description ?? '-'],
                  ['Receipt', v.receiptReference ?? '-'],
                  ['Total', formatMoney(v.total)],
                  ['Approved', v.approvedAt ? formatDateTime(v.approvedAt) : '-'],
                  ['Posted', v.postedAt ? formatDateTime(v.postedAt) : '-'],
                  [
                    'Journal',
                    v.journalEntryId ? (
                      <Link
                        key="j"
                        href={`/accounting/journal-entries/${v.journalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {v.journalNumber}
                      </Link>
                    ) : (
                      '-'
                    ),
                  ],
                  [
                    'Reimbursed',
                    v.replenishmentId ? 'Yes' : v.status === 'POSTED' ? 'Not yet' : '-',
                  ],
                  ['Void reason', v.voidReason ?? '-'],
                ]}
              />
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Line</TableHead>
                      <TableHead>Account</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {v.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>{l.description}</TableCell>
                        <TableCell className="text-xs">
                          {l.accountCode} {l.accountName}
                        </TableCell>
                        <TableCell>
                          <Amount value={l.amount} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <DialogFooter className="flex-wrap gap-2">
                {v.status === 'DRAFT' ? (
                  <Can permissions={[P['petty-cash.approve']]}>
                    <Button variant="outline" onClick={() => setPending('approve')}>
                      Approve
                    </Button>
                  </Can>
                ) : null}
                {v.status === 'APPROVED' ? (
                  <Can permissions={[P['petty-cash.post']]}>
                    <Button onClick={() => setPending('post')}>Post</Button>
                  </Can>
                ) : null}
                {v.status !== 'VOID' && !v.replenishmentId ? (
                  <Can permissions={[P['petty-cash.post']]}>
                    <Button variant="ghost" onClick={() => setPending('void')}>
                      Void
                    </Button>
                  </Can>
                ) : null}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {v ? (
        <>
          <OperationDialog
            open={pending === 'approve'}
            onOpenChange={(o) => !o && setPending(null)}
            title={`Approve ${v.documentNumber}`}
            description="Above the fund's limit the approver must differ from the preparer. No ledger effect yet."
            confirmLabel="Approve"
            loadingLabel="Approving..."
            resultLabel="Approved"
            steps={APPROVAL_STEPS}
            run={() => action.mutateAsync({ id: v.id, action: 'approve' })}
          />
          <OperationDialog
            open={pending === 'post'}
            onOpenChange={(o) => !o && setPending(null)}
            title={`Post ${v.documentNumber}`}
            description={`Debits each expense line and credits the ${v.fundCode} cash account for ${formatMoney(v.total)}.`}
            confirmLabel="Post"
            loadingLabel="Posting..."
            resultLabel="Posted"
            steps={POSTING_STEPS}
            run={() => action.mutateAsync({ id: v.id, action: 'post' })}
          />
          <ReasonDialog
            open={pending === 'void'}
            onOpenChange={(o) => !o && setPending(null)}
            title={`Void ${v.documentNumber}`}
            description={
              v.status === 'POSTED'
                ? 'Posts a reversal journal dated today; the fund balance is restored.'
                : 'The draft is voided without any ledger effect.'
            }
            confirmLabel="Void voucher"
            destructive
            loading={action.isPending}
            onConfirm={async (reason) => {
              try {
                await action.mutateAsync({ id: v.id, action: 'void', body: { reason } });
                toast.success(`${v.documentNumber} voided.`);
                setPending(null);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          />
        </>
      ) : null}
    </>
  );
}
