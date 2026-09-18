'use client';
import * as React from 'react';
import Link from 'next/link';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { ASSET_STATUSES, DEPRECIATION_METHODS, P, type AssetStatus } from '@accounting/types';
import { createAssetSchema, type CreateAssetInput } from '@accounting/validation';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormDescription,
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
import {
  useAssetCategories,
  useCreateFixedAsset,
  useFixedAssets,
  useUpdateFixedAsset,
} from '@/lib/api/assets-banking-hooks';
import type { FixedAsset } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { ASSETS_PATH, AssetStatusBadge, methodLabel } from './shared';

type AssetFormInput = z.input<typeof createAssetSchema>;

export function FixedAssetsPage() {
  const router = useAppRouter();
  const table = useTableState({ sortBy: 'assetNumber', sortDir: 'desc' });
  const [status, setStatus] = React.useState('ALL');
  const [categoryId, setCategoryId] = React.useState('ALL');
  const [creating, setCreating] = React.useState(false);
  const categories = useAssetCategories();
  const assets = useFixedAssets({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as AssetStatus),
    categoryId: categoryId === 'ALL' ? undefined : categoryId,
  });
  const columns = React.useMemo<ColumnDef<FixedAsset>[]>(
    () => [
      {
        accessorKey: 'assetNumber',
        header: 'Asset',
        cell: ({ row }) => (
          <Link
            href={`${ASSETS_PATH}/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.assetNumber}
          </Link>
        ),
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div>
            <div className="font-medium">{row.original.name}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.categoryName}
              {row.original.location ? ` · ${row.original.location}` : ''}
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'acquisitionDate',
        header: 'Acquired',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.acquisitionDate}</span>
        ),
      },
      {
        id: 'method',
        header: 'Method',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-xs">
            {methodLabel(row.original.depreciationMethod, row.original.decliningRatePercent)} ·{' '}
            {row.original.usefulLifeMonths} mo
          </span>
        ),
      },
      {
        id: 'cost',
        header: () => <div className="text-right">Cost</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.cost} />,
      },
      {
        id: 'accumulated',
        header: () => <div className="text-right">Accum. depr.</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.accumulatedDepreciation} zeroAsDash />,
      },
      {
        id: 'bookValue',
        header: () => <div className="text-right">Book value</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.bookValue} className="font-medium" />,
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <AssetStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );

  return (
    <>
      <PageHeader
        title="Fixed assets"
        description="The asset register. Capitalisation, depreciation, impairment, revaluation and disposal each post to the ledger, so cost and accumulated depreciation here always equal the asset accounts."
        actions={
          <Can permissions={[P['fixed-asset.manage']]}>
            <Button onClick={() => setCreating(true)}>
              <Plus /> New asset
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={assets.data}
        isLoading={assets.isLoading}
        isFetching={assets.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(a) => a.id}
        onRowClick={(a) => router.push(`${ASSETS_PATH}/${a.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Number, name, serial, location"
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
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {ASSET_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={categoryId}
              onValueChange={(v) => {
                setCategoryId(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All categories</SelectItem>
                {categories.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
      <AssetDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => router.push(`${ASSETS_PATH}/${id}`)}
      />
    </>
  );
}

/** Create / edit dialog. Cost, dates, life and method lock once the asset is capitalised. */
export function AssetDialog({
  open,
  asset,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  asset?: FixedAsset;
  onOpenChange: (open: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const categories = useAssetCategories();
  const create = useCreateFixedAsset();
  const update = useUpdateFixedAsset();
  const locked = Boolean(asset && asset.status !== 'DRAFT');
  const defaults = React.useCallback(
    (): AssetFormInput => ({
      name: asset?.name ?? '',
      description: asset?.description ?? undefined,
      categoryId: asset?.categoryId ?? '',
      acquisitionDate: asset?.acquisitionDate ?? today(),
      inServiceDate: asset?.inServiceDate ?? undefined,
      acquisitionCost: asset?.acquisitionCost ?? '',
      salvageValue: asset?.salvageValue ?? '0',
      usefulLifeMonths: asset?.usefulLifeMonths ?? undefined,
      depreciationMethod: asset?.depreciationMethod ?? undefined,
      decliningRatePercent: asset?.decliningRatePercent ?? null,
      location: asset?.location ?? undefined,
      serialNumber: asset?.serialNumber ?? undefined,
      reference: asset?.reference ?? undefined,
    }),
    [asset],
  );
  const form = useForm<AssetFormInput, unknown, CreateAssetInput>({
    resolver: zodResolver(createAssetSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const categoryId = form.watch('categoryId');
  const category = categories.data?.find((c) => c.id === categoryId);
  const method = form.watch('depreciationMethod') ?? category?.depreciationMethod;

  const submit = form.handleSubmit(async (values) => {
    try {
      if (asset) {
        // Only descriptive fields are editable after capitalisation.
        const body = locked
          ? {
              name: values.name,
              description: values.description,
              location: values.location,
              serialNumber: values.serialNumber,
              reference: values.reference,
            }
          : values;
        await update.mutateAsync({ id: asset.id, ...body });
        toast.success('Asset updated.');
      } else {
        const created = await create.mutateAsync(values);
        toast.success(`${created.assetNumber} registered as a draft.`);
        onCreated?.(created.id);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  const text = (
    name: 'name' | 'location' | 'serialNumber' | 'reference' | 'acquisitionCost' | 'salvageValue',
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
            <Input {...props} {...field} value={(field.value as string | undefined) ?? ''} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
  const date = (name: 'acquisitionDate' | 'inServiceDate', label: string, hint?: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="date"
              {...field}
              value={field.value ?? ''}
              disabled={locked}
              onChange={(e) => field.onChange(e.target.value || undefined)}
            />
          </FormControl>
          {hint ? <FormDescription>{hint}</FormDescription> : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{asset ? `Edit ${asset.assetNumber}` : 'Register asset'}</DialogTitle>
          <DialogDescription>
            {locked
              ? 'Cost, dates and depreciation terms are fixed once capitalised; use impairment or revaluation to change the carrying amount.'
              : 'A draft has no ledger effect. Capitalise it to post the cost and start depreciation.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {text('name', 'Name', { autoFocus: true })}
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="categoryId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={locked}>
                      <FormControl>
                        <SelectTrigger data-testid="asset-category">
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {categories.data
                          ?.filter((c) => c.status === 'ACTIVE' || c.id === field.value)
                          .map((c) => (
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
              {text('reference', 'Reference', { placeholder: 'PO / invoice' })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {date('acquisitionDate', 'Acquisition date')}
              {date('inServiceDate', 'In service', 'Defaults to the acquisition date.')}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {text('acquisitionCost', 'Acquisition cost', {
                inputMode: 'decimal',
                className: 'text-right tabular',
                disabled: locked,
              })}
              {text('salvageValue', 'Salvage value', {
                inputMode: 'decimal',
                className: 'text-right tabular',
                disabled: locked,
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="usefulLifeMonths"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Life (months)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        {...field}
                        value={field.value === undefined ? '' : String(field.value)}
                        placeholder={category ? String(category.usefulLifeMonths) : ''}
                        disabled={locked}
                        onChange={(e) =>
                          field.onChange(e.target.value === '' ? undefined : e.target.value)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="depreciationMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Method</FormLabel>
                    <Select
                      value={field.value ?? '__category__'}
                      onValueChange={(v) => field.onChange(v === '__category__' ? undefined : v)}
                      disabled={locked}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__category__">
                          Category default
                          {category ? ` (${methodLabel(category.depreciationMethod, null)})` : ''}
                        </SelectItem>
                        {DEPRECIATION_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {methodLabel(m, null)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="decliningRatePercent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Annual rate %</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value ?? ''}
                        disabled={locked || method !== 'DECLINING_BALANCE'}
                        placeholder={category?.decliningRatePercent ?? 'Double declining'}
                        onChange={(e) => field.onChange(e.target.value || null)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {text('location', 'Location')}
              {text('serialNumber', 'Serial number')}
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
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {asset ? 'Save' : 'Register'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
