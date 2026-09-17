'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  createCustomerSchema,
  createVendorSchema,
  type CreateCustomerInput,
  type CreateVendorInput,
} from '@accounting/validation';
import {
  Badge,
  Button,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useCreateParty, useParties, useUpdateParty } from '@/lib/api/subledger-hooks';
import type { Party } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { AccountCombobox, Amount } from '@/components/accounting/primitives';

export function PartiesPage({ cfg }: { cfg: SubledgerConfig }) {
  const router = useAppRouter();
  const params = useSearchParams();
  const { hasPermission } = useSession();
  const table = useTableState({ sortBy: 'name', sortDir: 'asc' });
  const [status, setStatus] = React.useState('ACTIVE');
  // `?action=create` (command palette) opens the create dialog directly.
  const [dialog, setDialog] = React.useState<{ open: boolean; party?: Party }>({
    open: params.get('action') === 'create',
  });
  const parties = useParties(cfg, {
    ...table.query,
    status: status === 'ALL' ? undefined : (status as 'ACTIVE' | 'INACTIVE'),
  });
  const canManage = hasPermission(cfg.permissions.partyManage);

  const columns = React.useMemo<ColumnDef<Party>[]>(
    () => [
      {
        accessorKey: 'code',
        header: 'Code',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.code}</span>,
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div>
            <Link
              href={`${cfg.party.path}/${row.original.id}`}
              className="font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.name}
            </Link>
            <div className="text-xs text-muted-foreground">
              {row.original.email ?? row.original.city ?? ''}
            </div>
          </div>
        ),
      },
      {
        id: 'terms',
        header: 'Terms',
        enableSorting: false,
        cell: ({ row }) => `${row.original.paymentTermsDays} days`,
      },
      {
        id: 'outstanding',
        header: () => <div className="text-right">Outstanding</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.balance.outstanding} zeroAsDash />,
      },
      {
        id: 'overdue',
        header: () => <div className="text-right">Overdue</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount
            value={row.original.balance.overdue}
            zeroAsDash
            className={row.original.balance.overdue !== '0.0000' ? 'text-critical' : ''}
          />
        ),
      },
      {
        id: 'credit',
        header: () => <div className="text-right">Unapplied credit</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.balance.unappliedCredit} zeroAsDash />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>
            {row.original.status}
          </Badge>
        ),
      },
    ],
    [cfg.party.path],
  );

  return (
    <>
      <PageHeader
        title={cfg.party.plural}
        description={
          cfg.side === 'AR'
            ? 'Who owes you money. Balances come from posted invoices and receipts.'
            : 'Whom you owe. Balances come from posted bills and payments.'
        }
        actions={
          <Can permissions={[cfg.permissions.partyManage]}>
            <Button onClick={() => setDialog({ open: true })}>
              <Plus /> New {cfg.party.singular.toLowerCase()}
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={parties.data}
        isLoading={parties.isLoading}
        error={parties.error}
        onRetry={() => void parties.refetch()}
        isFetching={parties.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(p) => p.id}
        onRowClick={(p) => router.push(`${cfg.party.path}/${p.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Code, name or email"
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
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="INACTIVE">Inactive</SelectItem>
                <SelectItem value="ALL">All</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
        emptyState={
          <EmptyState
            className="border-0"
            title={`No ${cfg.party.plural.toLowerCase()}`}
            description={
              canManage ? `Create the first ${cfg.party.singular.toLowerCase()}.` : undefined
            }
          />
        }
      />
      <PartyDialog
        cfg={cfg}
        open={dialog.open}
        party={dialog.party}
        onOpenChange={(open) => setDialog({ open })}
      />
    </>
  );
}

type PartyFormInput = z.input<typeof createCustomerSchema> & {
  defaultExpenseAccountId?: string | null;
};

export function PartyDialog({
  cfg,
  open,
  party,
  onOpenChange,
}: {
  cfg: SubledgerConfig;
  open: boolean;
  party?: Party;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateParty(cfg);
  const update = useUpdateParty(cfg);
  const schema = cfg.side === 'AR' ? createCustomerSchema : createVendorSchema;
  const defaults = React.useCallback(
    (): PartyFormInput => ({
      code: party?.code ?? '',
      name: party?.name ?? '',
      legalName: party?.legalName ?? undefined,
      taxIdentificationNumber: party?.taxIdentificationNumber ?? undefined,
      email: party?.email ?? undefined,
      phone: party?.phone ?? undefined,
      contactPerson: party?.contactPerson ?? undefined,
      paymentTermsDays: party?.paymentTermsDays ?? 30,
      currency: party?.currency ?? undefined,
      notes: party?.notes ?? undefined,
      addressLine1: party?.addressLine1 ?? undefined,
      city: party?.city ?? undefined,
      province: party?.province ?? undefined,
      postalCode: party?.postalCode ?? undefined,
      country: party?.country ?? 'PH',
      creditLimit: party?.creditLimit ?? null,
      defaultRevenueAccountId: party?.defaultRevenueAccountId ?? null,
      defaultExpenseAccountId: party?.defaultExpenseAccountId ?? null,
    }),
    [party],
  );
  const form = useForm<PartyFormInput, unknown, CreateCustomerInput | CreateVendorInput>({
    resolver: zodResolver(schema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (party) {
        await update.mutateAsync({ id: party.id, ...values });
        toast.success(`${cfg.party.singular} updated.`);
      } else {
        await create.mutateAsync(values);
        toast.success(`${cfg.party.singular} created.`);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  const text = (
    name: keyof PartyFormInput,
    label: string,
    props?: React.ComponentProps<typeof Input>,
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...props}
              {...field}
              value={(field.value as string | number | null | undefined) ?? ''}
              onChange={(e) =>
                field.onChange(
                  name === 'currency' ? e.target.value.toUpperCase() || undefined : e.target.value,
                )
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {party ? `Edit ${party.code}` : `New ${cfg.party.singular.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            Payment terms drive the default due date of new documents.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-2" noValidate>
            {text('code', 'Code', {
              placeholder: `${cfg.party.codePrefix}001`,
              className: 'uppercase font-mono',
              disabled: Boolean(party),
            })}
            {text('name', 'Name')}
            {text('legalName', 'Legal name')}
            {text('taxIdentificationNumber', 'TIN')}
            {text('email', 'Email', { type: 'email' })}
            {text('phone', 'Phone')}
            {text('contactPerson', 'Contact person')}
            {text('paymentTermsDays', 'Payment terms (days)', { type: 'number', min: 0 })}
            {text('currency', 'Currency', {
              className: 'font-mono uppercase',
              placeholder: 'Company base',
              maxLength: 3,
            })}
            {cfg.side === 'AR'
              ? text('creditLimit', 'Credit limit', {
                  inputMode: 'decimal',
                  placeholder: 'No limit',
                })
              : null}
            <FormField
              control={form.control}
              name={cfg.defaultLineAccountField}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Default {cfg.side === 'AR' ? 'revenue' : 'expense'} account</FormLabel>
                  <AccountCombobox
                    value={field.value ?? null}
                    onChange={(id) => field.onChange(id)}
                    placeholder="Optional"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            {text('addressLine1', 'Address')}
            {text('city', 'City')}
            {text('province', 'Province')}
            {text('postalCode', 'Postal code')}
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
            <DialogFooter className="md:col-span-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                {party ? 'Save changes' : `Create ${cfg.party.singular.toLowerCase()}`}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
