'use client';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { DEPRECIATION_METHODS, P } from '@accounting/types';
import { createAssetCategorySchema, type CreateAssetCategoryInput } from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAssetCategories,
  useCreateAssetCategory,
  useUpdateAssetCategory,
} from '@/lib/api/assets-banking-hooks';
import type { AssetCategory } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { AccountCombobox } from '@/components/accounting/primitives';
import { methodLabel } from './shared';

type CategoryFormInput = z.input<typeof createAssetCategorySchema>;

export function AssetCategoriesPage() {
  const { hasPermission } = useSession();
  const categories = useAssetCategories();
  const update = useUpdateAssetCategory();
  const [dialog, setDialog] = React.useState<{ open: boolean; category?: AssetCategory }>({
    open: false,
  });
  const canManage = hasPermission(P['fixed-asset.manage']);

  return (
    <>
      <PageHeader
        title="Asset categories"
        description="Default useful life, method and account overrides per class of asset. Blank accounts fall back to the company mappings."
        actions={
          <Can permissions={[P['fixed-asset.manage']]}>
            <Button onClick={() => setDialog({ open: true })}>
              <Plus /> New category
            </Button>
          </Can>
        }
      />
      {categories.isLoading ? (
        <TableSkeleton columns={5} />
      ) : categories.data?.length === 0 ? (
        <EmptyState title="No categories" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Life (months)</TableHead>
                  <TableHead className="text-right">Assets</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage ? <TableHead className="w-24" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.data?.map((c) => (
                  <TableRow key={c.id} data-testid="asset-category-row">
                    <TableCell className="font-mono text-xs">{c.code}</TableCell>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      {c.description ? (
                        <div className="text-xs text-muted-foreground">{c.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {methodLabel(c.depreciationMethod, c.decliningRatePercent)}
                    </TableCell>
                    <TableCell className="text-right tabular">{c.usefulLifeMonths}</TableCell>
                    <TableCell className="text-right tabular">{c.assetCount}</TableCell>
                    <TableCell>
                      <Badge variant={c.status === 'ACTIVE' ? 'success' : 'secondary'}>
                        {c.status}
                      </Badge>
                    </TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDialog({ open: true, category: c })}
                        >
                          <Pencil /> Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            try {
                              await update.mutateAsync({
                                id: c.id,
                                status: c.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                              });
                            } catch (err) {
                              toast.error(describeError(err));
                            }
                          }}
                        >
                          {c.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <CategoryDialog
        open={dialog.open}
        category={dialog.category}
        onOpenChange={(open) => setDialog({ open })}
      />
    </>
  );
}

function CategoryDialog({
  open,
  category,
  onOpenChange,
}: {
  open: boolean;
  category?: AssetCategory;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateAssetCategory();
  const update = useUpdateAssetCategory();
  const defaults = React.useCallback(
    (): CategoryFormInput => ({
      code: category?.code ?? '',
      name: category?.name ?? '',
      description: category?.description ?? undefined,
      usefulLifeMonths: category?.usefulLifeMonths ?? 60,
      depreciationMethod: category?.depreciationMethod ?? 'STRAIGHT_LINE',
      decliningRatePercent: category?.decliningRatePercent ?? null,
      assetAccountId: category?.assetAccountId ?? null,
      accumulatedDepreciationAccountId: category?.accumulatedDepreciationAccountId ?? null,
      depreciationExpenseAccountId: category?.depreciationExpenseAccountId ?? null,
    }),
    [category],
  );
  const form = useForm<CategoryFormInput, unknown, CreateAssetCategoryInput>({
    resolver: zodResolver(createAssetCategorySchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const method = form.watch('depreciationMethod');
  const submit = form.handleSubmit(async (values) => {
    try {
      if (category) await update.mutateAsync({ id: category.id, ...values });
      else await create.mutateAsync(values);
      toast.success(category ? 'Category updated.' : 'Category created.');
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  const account = (
    name: 'assetAccountId' | 'accumulatedDepreciationAccountId' | 'depreciationExpenseAccountId',
    label: string,
    types: Parameters<typeof AccountCombobox>[0]['types'],
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
            placeholder="Company mapping"
            types={types}
          />
          <FormMessage />
        </FormItem>
      )}
    />
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? `Edit ${category.code}` : 'New asset category'}</DialogTitle>
          <DialogDescription>
            New assets inherit the life and method; each asset can still override them.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
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
                        disabled={Boolean(category)}
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
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="usefulLifeMonths"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Useful life (months)</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} {...field} value={String(field.value ?? '')} />
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
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
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
                        disabled={method !== 'DECLINING_BALANCE'}
                        placeholder="Double declining"
                        onChange={(e) => field.onChange(e.target.value || null)}
                      />
                    </FormControl>
                    <FormDescription>Declining balance only.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {account('assetAccountId', 'Asset cost account', ['ASSET'])}
            {account('accumulatedDepreciationAccountId', 'Accumulated depreciation account', [
              'ASSET',
            ])}
            {account('depreciationExpenseAccountId', 'Depreciation expense account', ['EXPENSE'])}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {category ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
