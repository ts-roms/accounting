'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type {
  LeaseClassification,
  LeasePaymentFrequency,
  LeasePaymentTiming,
  LeaseStatus,
} from '@accounting/types';
import { LEASE_STATUSES, P } from '@accounting/types';
import {
  Button,
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
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateLease,
  useLeases,
  usePreviewLeaseSchedule,
  useUpdateLease,
} from '@/lib/api/lease-hooks';
import type { Lease, LeaseDetail, LeaseSchedulePreview } from '@/lib/api/lease-types';
import { AP_CONFIG } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { Amount, today } from '@/components/accounting/primitives';
import { BankAccountSelect } from '@/components/banking/shared';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, PageHeader } from '@/components/ui-ext/page';
import {
  ClassificationBadge,
  LEASES_PATH,
  LEASE_REPORTS_PATH,
  LEASE_RUNS_PATH,
  LeaseStatusBadge,
  frequencyLabel,
  timingLabel,
} from './shared';

export function LeasesPage() {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'commencementDate', sortDir: 'desc' });
  const [status, setStatus] = React.useState<LeaseStatus | 'ALL'>('ALL');
  const leases = useLeases({
    ...table.query,
    status: status === 'ALL' ? undefined : status,
  });
  const [creating, setCreating] = React.useState(false);
  const columns = React.useMemo<ColumnDef<Lease>[]>(
    () => [
      {
        accessorKey: 'leaseNumber',
        header: 'Lease',
        cell: ({ row }) => (
          <div>
            <span className="font-mono text-xs">{row.original.leaseNumber}</span>
            <div className="font-medium">{row.original.name}</div>
            {row.original.vendorName ? (
              <div className="text-xs text-muted-foreground">{row.original.vendorName}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'classification',
        header: 'Classification',
        enableSorting: false,
        cell: ({ row }) => <ClassificationBadge classification={row.original.classification} />,
      },
      {
        id: 'term',
        header: 'Term',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {row.original.commencementDate} → {row.original.endDate}
            <span className="ml-2 text-xs text-muted-foreground">{row.original.termMonths} mo</span>
          </span>
        ),
      },
      {
        id: 'payment',
        header: () => <div className="text-right">Payment</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-right">
            <Amount value={row.original.paymentAmount} />
            <div className="text-xs text-muted-foreground">
              {frequencyLabel(row.original.paymentFrequency)}{' '}
              {timingLabel(row.original.paymentTiming)}
            </div>
          </div>
        ),
      },
      {
        id: 'liability',
        header: () => <div className="text-right">Liability</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.liabilityBalance} zeroAsDash />,
      },
      {
        id: 'carrying',
        header: () => <div className="text-right">ROU carrying</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.rouCarrying} zeroAsDash />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <LeaseStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Leases"
        description="Lease contracts as data: the schedule, the right-of-use asset and the liability derive from the terms. Runs post interest and depreciation; instalments settle the liability."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href={LEASE_RUNS_PATH}>Lease runs</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={LEASE_REPORTS_PATH}>Reports</Link>
            </Button>
            <Can permissions={[P['lease.manage']]}>
              <Button size="sm" onClick={() => setCreating(true)} data-testid="lease-new">
                <Plus /> New lease
              </Button>
            </Can>
          </div>
        }
      />
      <DataTable
        columns={columns}
        data={leases.data}
        isLoading={leases.isLoading}
        isFetching={leases.isFetching}
        error={leases.error}
        onRetry={() => void leases.refetch()}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(r) => r.id}
        onRowClick={(r) => router.push(`${LEASES_PATH}/${r.id}`)}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search number, name, reference"
              value={table.query.search ?? ''}
              onChange={(e) => table.setSearch(e.target.value)}
              className="w-64"
            />
            <Select value={status} onValueChange={(v) => setStatus(v as LeaseStatus | 'ALL')}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {LEASE_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <LeaseDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={(l) => router.push(`${LEASES_PATH}/${l.id}`)}
      />
    </>
  );
}

interface FormState {
  name: string;
  description: string;
  vendorId: string | null;
  commencementDate: string;
  termMonths: string;
  paymentAmount: string;
  paymentFrequency: LeasePaymentFrequency;
  paymentTiming: LeasePaymentTiming;
  annualDiscountRate: string;
  initialDirectCosts: string;
  leaseIncentives: string;
  underlyingAssetValue: string;
  classificationOverride: LeaseClassification | 'AUTO';
  bankAccountId: string | null;
  location: string;
  reference: string;
}

const empty = (): FormState => ({
  name: '',
  description: '',
  vendorId: null,
  commencementDate: today(),
  termMonths: '36',
  paymentAmount: '',
  paymentFrequency: 'MONTHLY',
  paymentTiming: 'IN_ADVANCE',
  annualDiscountRate: '',
  initialDirectCosts: '',
  leaseIncentives: '',
  underlyingAssetValue: '',
  classificationOverride: 'AUTO',
  bankAccountId: null,
  location: '',
  reference: '',
});

const fromLease = (l: LeaseDetail): FormState => ({
  name: l.name,
  description: l.description ?? '',
  vendorId: l.vendorId,
  commencementDate: l.commencementDate,
  termMonths: String(l.termMonths),
  paymentAmount: l.paymentAmount,
  paymentFrequency: l.paymentFrequency,
  paymentTiming: l.paymentTiming,
  annualDiscountRate: l.annualDiscountRate ?? '',
  initialDirectCosts: Number(l.initialDirectCosts) ? l.initialDirectCosts : '',
  leaseIncentives: Number(l.leaseIncentives) ? l.leaseIncentives : '',
  underlyingAssetValue: l.underlyingAssetValue ?? '',
  classificationOverride: l.classificationOverride ?? 'AUTO',
  bankAccountId: l.bankAccountId,
  location: l.location ?? '',
  reference: l.reference ?? '',
});

/** Create / edit a contract. Terms are editable while the lease is a draft; the preview shows the schedule they imply. */
export function LeaseDialog({
  open,
  onOpenChange,
  lease,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease?: LeaseDetail;
  onSaved?: (lease: LeaseDetail) => void;
}) {
  const create = useCreateLease();
  const update = useUpdateLease();
  const preview = usePreviewLeaseSchedule();
  const [form, setForm] = React.useState<FormState>(empty());
  const [schedule, setSchedule] = React.useState<LeaseSchedulePreview | null>(null);
  const draftTerms = !lease || lease.status === 'DRAFT';
  React.useEffect(() => {
    if (open) {
      setForm(lease ? fromLease(lease) : empty());
      setSchedule(null);
    }
  }, [open, lease]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const text = (v: string) => (v.trim() ? v.trim() : undefined);
  const amount = (v: string) => (v.trim() ? v.trim() : undefined);

  const runPreview = async () => {
    try {
      const s = await preview.mutateAsync({
        commencementDate: form.commencementDate,
        termMonths: Number(form.termMonths),
        paymentAmount: form.paymentAmount,
        paymentFrequency: form.paymentFrequency,
        paymentTiming: form.paymentTiming,
        annualDiscountRate: text(form.annualDiscountRate),
        initialDirectCosts: amount(form.initialDirectCosts) ?? '0',
        leaseIncentives: amount(form.leaseIncentives) ?? '0',
      });
      setSchedule(s);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  const submit = async () => {
    try {
      const terms = draftTerms
        ? {
            commencementDate: form.commencementDate,
            termMonths: Number(form.termMonths),
            paymentAmount: form.paymentAmount,
            paymentFrequency: form.paymentFrequency,
            paymentTiming: form.paymentTiming,
            annualDiscountRate: text(form.annualDiscountRate) ?? null,
            initialDirectCosts: amount(form.initialDirectCosts) ?? '0',
            leaseIncentives: amount(form.leaseIncentives) ?? '0',
            underlyingAssetValue: amount(form.underlyingAssetValue) ?? null,
            classificationOverride:
              form.classificationOverride === 'AUTO' ? null : form.classificationOverride,
          }
        : {};
      const common = {
        name: form.name.trim(),
        description: text(form.description),
        vendorId: form.vendorId,
        bankAccountId: form.bankAccountId,
        location: text(form.location),
        reference: text(form.reference),
      };
      const saved = lease
        ? await update.mutateAsync({ id: lease.id, ...common, ...terms })
        : await create.mutateAsync({ ...common, ...terms } as Parameters<
            typeof create.mutateAsync
          >[0]);
      toast.success(lease ? 'Lease updated.' : `${saved.leaseNumber} captured as a draft.`);
      onOpenChange(false);
      onSaved?.(saved);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{lease ? `Edit ${lease.leaseNumber}` : 'New lease'}</DialogTitle>
          <DialogDescription>
            {draftTerms
              ? 'Nothing posts until the lease is commenced. Leases within the short-term / low-value thresholds are exempt and expensed as paid.'
              : 'Terms of a commenced lease change only through a remeasurement; descriptive fields, the bank account and dimensions can still be edited.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1 sm:col-span-2 lg:col-span-3">
            <Label>Name</Label>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              data-testid="lease-name"
            />
          </div>
          <div className="space-y-1">
            <Label>Lessor</Label>
            <PartyCombobox
              cfg={AP_CONFIG}
              value={form.vendorId}
              onChange={(id) => set('vendorId', id)}
            />
          </div>
          <div className="space-y-1">
            <Label>Pays from</Label>
            <BankAccountSelect
              value={form.bankAccountId}
              onChange={(id) => set('bankAccountId', id)}
            />
          </div>
          <div className="space-y-1">
            <Label>Commencement</Label>
            <Input
              type="date"
              value={form.commencementDate}
              disabled={!draftTerms}
              onChange={(e) => set('commencementDate', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Term (months)</Label>
            <Input
              inputMode="numeric"
              value={form.termMonths}
              disabled={!draftTerms}
              onChange={(e) => set('termMonths', e.target.value)}
              data-testid="lease-term"
            />
          </div>
          <div className="space-y-1">
            <Label>Payment per period</Label>
            <Input
              inputMode="decimal"
              className="text-right tabular"
              value={form.paymentAmount}
              disabled={!draftTerms}
              onChange={(e) => set('paymentAmount', e.target.value)}
              data-testid="lease-payment"
            />
          </div>
          <div className="space-y-1">
            <Label>Annual discount rate %</Label>
            <Input
              inputMode="decimal"
              placeholder="Company default"
              value={form.annualDiscountRate}
              disabled={!draftTerms}
              onChange={(e) => set('annualDiscountRate', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Frequency</Label>
            <Select
              value={form.paymentFrequency}
              disabled={!draftTerms}
              onValueChange={(v) => set('paymentFrequency', v as LeasePaymentFrequency)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MONTHLY">Monthly</SelectItem>
                <SelectItem value="QUARTERLY">Quarterly</SelectItem>
                <SelectItem value="ANNUAL">Annual</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Timing</Label>
            <Select
              value={form.paymentTiming}
              disabled={!draftTerms}
              onValueChange={(v) => set('paymentTiming', v as LeasePaymentTiming)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="IN_ADVANCE">In advance (start of period)</SelectItem>
                <SelectItem value="IN_ARREARS">In arrears (end of period)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Initial direct costs</Label>
            <Input
              inputMode="decimal"
              className="text-right tabular"
              value={form.initialDirectCosts}
              disabled={!draftTerms}
              onChange={(e) => set('initialDirectCosts', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Lease incentives received</Label>
            <Input
              inputMode="decimal"
              className="text-right tabular"
              value={form.leaseIncentives}
              disabled={!draftTerms}
              onChange={(e) => set('leaseIncentives', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Underlying asset value</Label>
            <Input
              inputMode="decimal"
              className="text-right tabular"
              placeholder="For the low-value test"
              value={form.underlyingAssetValue}
              disabled={!draftTerms}
              onChange={(e) => set('underlyingAssetValue', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Classification</Label>
            <Select
              value={form.classificationOverride}
              disabled={!draftTerms}
              onValueChange={(v) =>
                set('classificationOverride', v as FormState['classificationOverride'])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">From the thresholds</SelectItem>
                <SelectItem value="FINANCE">On balance sheet</SelectItem>
                <SelectItem value="SHORT_TERM">Short-term exemption</SelectItem>
                <SelectItem value="LOW_VALUE">Low-value exemption</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Location</Label>
            <Input value={form.location} onChange={(e) => set('location', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Contract reference</Label>
            <Input value={form.reference} onChange={(e) => set('reference', e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2 lg:col-span-3">
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
        </div>
        {schedule ? <PreviewTable schedule={schedule} /> : null}
        <DialogFooter>
          {draftTerms ? (
            <Button
              variant="outline"
              onClick={runPreview}
              disabled={preview.isPending || !form.paymentAmount || !form.termMonths}
              data-testid="lease-preview"
            >
              Preview schedule
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={create.isPending || update.isPending || !form.name.trim()}
            data-testid="lease-save"
          >
            {lease ? 'Save' : 'Create draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewTable({ schedule }: { schedule: LeaseSchedulePreview }) {
  return (
    <div className="rounded-md border" data-testid="lease-preview-table">
      <div className="grid grid-cols-2 gap-2 p-3 text-sm sm:grid-cols-4">
        <div>
          <div className="type-label">Liability at commencement</div>
          <Amount value={schedule.initialLiability} className="text-left font-semibold" />
        </div>
        <div>
          <div className="type-label">Right-of-use cost</div>
          <Amount value={schedule.rouCost} className="text-left font-semibold" />
        </div>
        <div>
          <div className="type-label">Total payments</div>
          <Amount value={schedule.totalPayments} className="text-left font-semibold" />
        </div>
        <div>
          <div className="type-label">Total interest</div>
          <Amount value={schedule.totalInterest} className="text-left font-semibold" />
        </div>
      </div>
      <div className="max-h-56 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Payment</TableHead>
              <TableHead className="text-right">Interest</TableHead>
              <TableHead className="text-right">Depreciation</TableHead>
              <TableHead className="text-right">Closing liability</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedule.lines.map((l) => (
              <TableRow key={l.sequence}>
                <TableCell className="whitespace-nowrap text-xs">
                  {l.sequence} · {l.periodStart}
                </TableCell>
                <TableCell>
                  <Amount value={l.payment} zeroAsDash />
                </TableCell>
                <TableCell>
                  <Amount value={l.interest} zeroAsDash />
                </TableCell>
                <TableCell>
                  <Amount value={l.depreciation} zeroAsDash />
                </TableCell>
                <TableCell>
                  <Amount value={l.closingLiability} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
