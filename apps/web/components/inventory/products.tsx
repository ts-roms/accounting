'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, ArrowLeft, Pencil, Plus, Search, Tags } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { COSTING_METHODS, P, PRODUCT_TYPES, TRACKING_MODES } from '@accounting/types';
import {
  createProductCategorySchema,
  createProductSchema,
  type CreateProductCategoryInput,
  type CreateProductInput,
} from '@accounting/validation';
import {
  Badge,
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
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateCategory,
  useCreateProduct,
  useProduct,
  useProductCategories,
  useProducts,
  useStockCard,
  useStockOnHand,
  useUpdateCategory,
  useUpdateProduct,
} from '@/lib/api/inventory-hooks';
import type { Product, ProductCategory } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { AccountCombobox, Amount } from '@/components/accounting/primitives';
import { trimAmount } from '@/components/subledger/document-detail';
import { WarehouseSelect } from './pickers';

export const PRODUCTS_PATH = '/inventory/products';

const qty = (v: string | null | undefined) => (v === null || v === undefined ? '-' : trimAmount(v));

export function ProductsPage() {
  const router = useRouter();
  const { hasPermission } = useSession();
  const table = useTableState({ sortBy: 'sku', sortDir: 'asc' });
  const [status, setStatus] = React.useState('ACTIVE');
  const [belowReorder, setBelowReorder] = React.useState(false);
  const [dialog, setDialog] = React.useState<{ open: boolean; product?: Product }>({ open: false });
  const [categories, setCategories] = React.useState(false);
  const products = useProducts({
    ...table.query,
    status: status === 'ALL' ? undefined : (status as 'ACTIVE' | 'INACTIVE'),
    belowReorder: belowReorder || undefined,
  });

  const columns = React.useMemo<ColumnDef<Product>[]>(
    () => [
      {
        accessorKey: 'sku',
        header: 'SKU',
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.sku}</span>,
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div>
            <Link
              href={`${PRODUCTS_PATH}/${row.original.id}`}
              className="font-medium hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.name}
            </Link>
            <div className="text-xs text-muted-foreground">{row.original.categoryName ?? ''}</div>
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            <Badge variant="outline">{titleCase(row.original.productType)}</Badge>
            {row.original.trackingMode !== 'NONE' ? (
              <Badge variant="secondary">{titleCase(row.original.trackingMode)}</Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: 'onHand',
        header: () => <div className="text-right">On hand</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="tabular block text-right">
            {row.original.productType === 'GOODS'
              ? `${qty(row.original.quantityOnHand)} ${row.original.unitOfMeasure}`
              : '-'}
          </span>
        ),
      },
      {
        id: 'value',
        header: () => <div className="text-right">Stock value</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.stockValue} zeroAsDash />,
      },
      {
        id: 'salePrice',
        header: () => <div className="text-right">Sale price</div>,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.salePrice ? (
            <Amount value={row.original.salePrice} />
          ) : (
            <span className="block text-right text-muted-foreground">-</span>
          ),
      },
      {
        id: 'reorder',
        header: 'Reorder',
        enableSorting: false,
        cell: ({ row }) => {
          const p = row.original;
          if (p.productType !== 'GOODS' || !p.reorderLevel)
            return <span className="text-muted-foreground">-</span>;
          const below = Number(p.quantityOnHand) <= Number(p.reorderLevel);
          return (
            <span className={below ? 'flex items-center gap-1 text-critical' : ''}>
              {below ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
              at {qty(p.reorderLevel)}
            </span>
          );
        },
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
    [],
  );

  return (
    <>
      <PageHeader
        title="Products"
        description="Goods carry stock and cost; services do not. Costing method and tracking (lot / serial) are fixed once a product has stock."
        actions={
          <>
            <Can permissions={[P['product.manage']]}>
              <Button variant="outline" onClick={() => setCategories(true)}>
                <Tags /> Categories
              </Button>
              <Button onClick={() => setDialog({ open: true })}>
                <Plus /> New product
              </Button>
            </Can>
          </>
        }
      />
      <DataTable
        columns={columns}
        data={products.data}
        isLoading={products.isLoading}
        isFetching={products.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(p) => p.id}
        onRowClick={(p) => router.push(`${PRODUCTS_PATH}/${p.id}`)}
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="SKU, name or barcode"
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
            <div className="flex items-center gap-2">
              <Checkbox
                id="below-reorder"
                checked={belowReorder}
                onCheckedChange={(v) => {
                  setBelowReorder(v === true);
                  table.resetPage();
                }}
              />
              <Label htmlFor="below-reorder" className="font-normal">
                Below reorder level
              </Label>
            </div>
          </>
        }
        emptyState={
          <EmptyState
            className="border-0"
            title="No products"
            description={
              hasPermission(P['product.manage']) ? 'Create the first product.' : undefined
            }
          />
        }
      />
      <ProductDialog
        open={dialog.open}
        product={dialog.product}
        onOpenChange={(open) => setDialog({ open })}
      />
      <CategoriesDialog open={categories} onOpenChange={setCategories} />
    </>
  );
}

type ProductFormInput = z.input<typeof createProductSchema>;

export function ProductDialog({
  open,
  product,
  onOpenChange,
}: {
  open: boolean;
  product?: Product;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const categories = useProductCategories();
  const hasStock = Boolean(
    product && product.quantityOnHand !== '0' && product.quantityOnHand !== '0.0000',
  );
  const defaults = React.useCallback(
    (): ProductFormInput => ({
      sku: product?.sku ?? '',
      name: product?.name ?? '',
      description: product?.description ?? undefined,
      categoryId: product?.categoryId ?? null,
      productType: product?.productType ?? 'GOODS',
      trackingMode: product?.trackingMode ?? 'NONE',
      costingMethod: product?.costingMethod ?? null,
      unitOfMeasure: product?.unitOfMeasure ?? 'pc',
      barcode: product?.barcode ?? undefined,
      salePrice: product?.salePrice ? trimAmount(product.salePrice) : null,
      purchasePrice: product?.purchasePrice ? trimAmount(product.purchasePrice) : null,
      standardCost: product?.standardCost ? trimAmount(product.standardCost) : null,
      reorderLevel: product?.reorderLevel ? trimAmount(product.reorderLevel) : null,
      reorderQuantity: product?.reorderQuantity ? trimAmount(product.reorderQuantity) : null,
      inventoryAccountId: product?.inventoryAccountId ?? null,
      cogsAccountId: product?.cogsAccountId ?? null,
      revenueAccountId: product?.revenueAccountId ?? null,
      expenseAccountId: product?.expenseAccountId ?? null,
    }),
    [product],
  );
  const form = useForm<ProductFormInput, unknown, CreateProductInput>({
    resolver: zodResolver(createProductSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const productType = form.watch('productType');

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const payload = { ...values, sku: values.sku.toUpperCase() };
      if (product) {
        await update.mutateAsync({ id: product.id, ...payload });
        toast.success('Product updated.');
      } else {
        await create.mutateAsync(payload);
        toast.success('Product created.');
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  const text = (
    name: keyof ProductFormInput,
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
              value={(field.value as string | null | undefined) ?? ''}
              onChange={(e) =>
                field.onChange(
                  props?.inputMode === 'decimal' && e.target.value === '' ? null : e.target.value,
                )
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
  const account = (
    name: 'inventoryAccountId' | 'cogsAccountId' | 'revenueAccountId' | 'expenseAccountId',
    label: string,
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <AccountCombobox
            value={field.value ?? null}
            onChange={(id) => field.onChange(id)}
            placeholder="Company default"
          />
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{product ? `Edit ${product.sku}` : 'New product'}</DialogTitle>
          <DialogDescription>
            Account overrides are optional; the category, then the company mappings, apply
            otherwise.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-3" noValidate>
            {text('sku', 'SKU', { className: 'uppercase font-mono', disabled: Boolean(product) })}
            <div className="md:col-span-2">{text('name', 'Name')}</div>
            <FormField
              control={form.control}
              name="categoryId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select
                    value={field.value ?? '__none__'}
                    onValueChange={(v) => field.onChange(v === '__none__' ? null : v)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {(categories.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.code} - {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="productType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select
                    value={field.value ?? 'GOODS'}
                    onValueChange={field.onChange}
                    disabled={hasStock}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="product-type">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PRODUCT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {titleCase(t)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            {text('unitOfMeasure', 'Unit')}
            {productType === 'GOODS' ? (
              <>
                <FormField
                  control={form.control}
                  name="trackingMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tracking</FormLabel>
                      <Select
                        value={field.value ?? 'NONE'}
                        onValueChange={field.onChange}
                        disabled={hasStock}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {TRACKING_MODES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t === 'NONE'
                                ? 'None'
                                : t === 'LOT'
                                  ? 'Lot / batch'
                                  : 'Serial numbers'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="costingMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Costing</FormLabel>
                      <Select
                        value={field.value ?? '__default__'}
                        onValueChange={(v) => field.onChange(v === '__default__' ? null : v)}
                        disabled={hasStock}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__default__">Company default</SelectItem>
                          {COSTING_METHODS.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m === 'FIFO' ? 'FIFO' : 'Weighted average'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                {text('barcode', 'Barcode')}
              </>
            ) : null}
            {text('salePrice', 'Sale price', { inputMode: 'decimal' })}
            {text('purchasePrice', 'Purchase price', { inputMode: 'decimal' })}
            {productType === 'GOODS' ? (
              text('standardCost', 'Standard cost', { inputMode: 'decimal' })
            ) : (
              <div />
            )}
            {productType === 'GOODS' ? (
              <>
                {text('reorderLevel', 'Reorder level', { inputMode: 'decimal' })}
                {text('reorderQuantity', 'Reorder quantity', { inputMode: 'decimal' })}
                <div />
                {account('inventoryAccountId', 'Inventory account')}
                {account('cogsAccountId', 'COGS account')}
              </>
            ) : null}
            {account('revenueAccountId', 'Revenue account')}
            {account('expenseAccountId', 'Expense account')}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className="md:col-span-3">
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                </FormItem>
              )}
            />
            {hasStock ? (
              <p className="text-xs text-muted-foreground md:col-span-3">
                Type, tracking and costing are locked while the product has stock on hand.
              </p>
            ) : null}
            <DialogFooter className="md:col-span-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                {product ? 'Save changes' : 'Create product'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

type CategoryFormInput = z.input<typeof createProductCategorySchema>;

function CategoriesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const categories = useProductCategories();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const [editing, setEditing] = React.useState<ProductCategory | null>(null);
  const form = useForm<CategoryFormInput, unknown, CreateProductCategoryInput>({
    resolver: zodResolver(createProductCategorySchema),
    defaultValues: { code: '', name: '' },
  });
  React.useEffect(() => {
    form.reset(
      editing
        ? {
            code: editing.code,
            name: editing.name,
            description: editing.description ?? undefined,
            inventoryAccountId: editing.inventoryAccountId,
            cogsAccountId: editing.cogsAccountId,
            revenueAccountId: editing.revenueAccountId,
            expenseAccountId: editing.expenseAccountId,
          }
        : { code: '', name: '' },
    );
  }, [editing, form]);
  const submit = form.handleSubmit(async (values) => {
    try {
      if (editing) await update.mutateAsync({ id: editing.id, ...values });
      else await create.mutateAsync(values);
      toast.success(editing ? 'Category updated.' : 'Category created.');
      setEditing(null);
      form.reset({ code: '', name: '' });
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Product categories</DialogTitle>
          <DialogDescription>Group products and give them default GL accounts.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Products</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(categories.data ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.code}</TableCell>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="text-right">{c.productCount}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${c.code}`}
                        onClick={() => setEditing(c)}
                      >
                        <Pencil />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {categories.data?.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      No categories yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          <Form {...form}>
            <form onSubmit={submit} className="space-y-3" noValidate>
              <h3 className="text-sm font-medium">
                {editing ? `Edit ${editing.code}` : 'New category'}
              </h3>
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Code</FormLabel>
                    <FormControl>
                      <Input
                        className="uppercase font-mono"
                        disabled={Boolean(editing)}
                        {...field}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
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
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {(
                [
                  'inventoryAccountId',
                  'cogsAccountId',
                  'revenueAccountId',
                  'expenseAccountId',
                ] as const
              ).map((name) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {
                          {
                            inventoryAccountId: 'Inventory account',
                            cogsAccountId: 'COGS account',
                            revenueAccountId: 'Revenue account',
                            expenseAccountId: 'Expense account',
                          }[name]
                        }
                      </FormLabel>
                      <AccountCombobox
                        value={field.value ?? null}
                        onChange={(id) => field.onChange(id)}
                        placeholder="Company default"
                      />
                    </FormItem>
                  )}
                />
              ))}
              <div className="flex justify-end gap-2">
                {editing ? (
                  <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                    New instead
                  </Button>
                ) : null}
                <Button type="submit" loading={form.formState.isSubmitting}>
                  {editing ? 'Save' : 'Add category'}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProductDetailPage({ id }: { id: string }) {
  const { hasPermission } = useSession();
  const product = useProduct(id);
  const [edit, setEdit] = React.useState(false);
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const stock = useStockOnHand({ productId: id, includeZero: true }, Boolean(id));
  const card = useStockCard(id, { warehouseId: warehouseId ?? undefined, pageSize: 50 });
  if (product.isLoading || !product.data) return <Skeleton className="h-96" />;
  const p = product.data;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {p.name}
            <Badge variant={p.status === 'ACTIVE' ? 'success' : 'secondary'}>{p.status}</Badge>
            <Badge variant="outline">{titleCase(p.productType)}</Badge>
            {p.trackingMode !== 'NONE' ? (
              <Badge variant="secondary">{titleCase(p.trackingMode)}</Badge>
            ) : null}
          </span>
        }
        description={`${p.sku}${p.categoryName ? ` - ${p.categoryName}` : ''}${p.productType === 'GOODS' ? ` - ${p.costingMethod ? (p.costingMethod === 'FIFO' ? 'FIFO' : 'Weighted average') : 'company default costing'}` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={PRODUCTS_PATH}>
                <ArrowLeft /> All products
              </Link>
            </Button>
            {hasPermission(P['product.manage']) ? (
              <Button variant="outline" size="sm" onClick={() => setEdit(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="On hand"
          value={p.productType === 'GOODS' ? `${qty(p.quantityOnHand)} ${p.unitOfMeasure}` : 'n/a'}
        />
        <Stat label="Stock value" value={<Amount value={p.stockValue} className="text-left" />} />
        <Stat
          label="Sale price"
          value={p.salePrice ? <Amount value={p.salePrice} className="text-left" /> : '-'}
        />
        <Stat
          label="Reorder level"
          value={p.reorderLevel ? qty(p.reorderLevel) : '-'}
          danger={Boolean(p.reorderLevel && Number(p.quantityOnHand) <= Number(p.reorderLevel))}
        />
      </div>
      {p.productType === 'GOODS' ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Stock by warehouse</CardTitle>
              <CardDescription>
                Quantity and value per warehouse{p.trackingMode === 'LOT' ? ' and lot' : ''}.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {!stock.data ? (
                <TableSkeleton columns={3} rows={3} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Warehouse</TableHead>
                      {p.trackingMode === 'LOT' ? <TableHead>Lot</TableHead> : null}
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stock.data.rows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="py-6 text-center text-sm text-muted-foreground"
                        >
                          No stock.
                        </TableCell>
                      </TableRow>
                    ) : (
                      stock.data.rows.map((r) => (
                        <TableRow key={`${r.warehouseId}-${r.lotId ?? ''}`}>
                          <TableCell className="font-mono text-xs">{r.warehouseCode}</TableCell>
                          {p.trackingMode === 'LOT' ? (
                            <TableCell className="text-xs">
                              {r.lotNumber ?? '-'}
                              {r.expiryDate ? (
                                <span className="ml-1 text-muted-foreground">
                                  exp {r.expiryDate}
                                </span>
                              ) : null}
                            </TableCell>
                          ) : null}
                          <TableCell className="tabular text-right">
                            {qty(r.quantityOnHand)}
                          </TableCell>
                          <TableCell>
                            <Amount value={r.totalCost} currency={stock.data!.currency} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base">Stock card</CardTitle>
                <CardDescription>
                  Every movement with its cost and the running balance.
                </CardDescription>
              </div>
              <WarehouseSelect
                value={warehouseId}
                onChange={setWarehouseId}
                allowNone
                className="w-56"
              />
            </CardHeader>
            <CardContent className="p-0">
              {!card.data ? (
                <TableSkeleton columns={6} rows={5} />
              ) : (
                <Table data-testid="stock-card">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Date</TableHead>
                      <TableHead>Movement</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead className="text-right">In</TableHead>
                      <TableHead className="text-right">Out</TableHead>
                      <TableHead className="text-right">Unit cost</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Journal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {card.data.items.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={8}
                          className="py-6 text-center text-sm text-muted-foreground"
                        >
                          No movements.
                        </TableCell>
                      </TableRow>
                    ) : (
                      card.data.items.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="whitespace-nowrap">{m.movementDate}</TableCell>
                          <TableCell>
                            <div className="text-xs">{titleCase(m.movementType)}</div>
                            <div className="text-[10px] uppercase text-muted-foreground">
                              {titleCase(m.sourceType)}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {m.warehouseCode}
                            {m.lotNumber ? (
                              <span className="ml-1 text-muted-foreground">{m.lotNumber}</span>
                            ) : null}
                          </TableCell>
                          <TableCell className="tabular text-right">
                            {m.quantityIn === '0.0000' ? '' : qty(m.quantityIn)}
                          </TableCell>
                          <TableCell className="tabular text-right">
                            {m.quantityOut === '0.0000' ? '' : qty(m.quantityOut)}
                          </TableCell>
                          <TableCell>
                            <Amount value={m.unitCost} />
                          </TableCell>
                          <TableCell className="tabular text-right font-medium">
                            {qty(m.balanceAfter)}
                          </TableCell>
                          <TableCell>
                            {m.journalNumber ? (
                              <span className="font-mono text-xs">{m.journalNumber}</span>
                            ) : (
                              <span className="text-xs text-muted-foreground">-</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
      <ProductDialog open={edit} product={p} onOpenChange={setEdit} />
    </>
  );
}

function Stat({
  label,
  value,
  danger,
}: {
  label: string;
  value: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-lg font-semibold ${danger ? 'text-critical' : ''}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
