'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Search, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { COSTING_METHODS, P } from '@accounting/types';
import { inventorySettingsSchema, type InventorySettingsInput } from '@accounting/validation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
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
  cn,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useInventorySettings,
  useInventoryValuation,
  useStockOnHand,
  useUpdateInventorySettings,
} from '@/lib/api/inventory-hooks';
import { useSession } from '@/lib/auth/session';
import { PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { trimAmount } from '@/components/subledger/document-detail';
import { WarehouseSelect } from './pickers';
import { PRODUCTS_PATH } from './products';

const qty = (v: string) => trimAmount(v);

/** Stock on hand by product / warehouse / lot with reorder flags. */
export function StockOnHandPage() {
  const [warehouseId, setWarehouseId] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [includeZero, setIncludeZero] = React.useState(false);
  const stock = useStockOnHand({
    warehouseId: warehouseId ?? undefined,
    search: search || undefined,
    includeZero: includeZero || undefined,
  });
  return (
    <>
      <PageHeader
        title="Stock on hand"
        description="Quantities and values from the inventory subledger. Value = what the general ledger carries for these goods."
      />
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="SKU or name"
              className="w-64 pl-8"
            />
          </div>
          <WarehouseSelect
            value={warehouseId}
            onChange={setWarehouseId}
            allowNone
            className="w-56"
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="include-zero"
              checked={includeZero}
              onCheckedChange={(v) => setIncludeZero(v === true)}
            />
            <Label htmlFor="include-zero" className="font-normal">
              Include zero balances
            </Label>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          {!stock.data ? (
            <TableSkeleton columns={7} rows={8} />
          ) : (
            <Table data-testid="stock-on-hand">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Product</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Lot</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Avg cost</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Reorder</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      No stock matches the filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  stock.data.rows.map((r) => (
                    <TableRow key={`${r.productId}-${r.warehouseId}-${r.lotId ?? ''}`}>
                      <TableCell>
                        <Link href={`${PRODUCTS_PATH}/${r.productId}`} className="hover:underline">
                          <span className="font-mono text-xs text-muted-foreground">{r.sku}</span>{' '}
                          {r.productName}
                        </Link>
                        <div className="text-xs text-muted-foreground">{r.categoryName ?? ''}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.warehouseCode}</TableCell>
                      <TableCell className="text-xs">
                        {r.lotNumber ?? '-'}
                        {r.expiryDate ? (
                          <span className="ml-1 text-muted-foreground">exp {r.expiryDate}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {qty(r.quantityOnHand)}{' '}
                        <span className="text-xs text-muted-foreground">{r.unitOfMeasure}</span>
                      </TableCell>
                      <TableCell>
                        <Amount value={r.averageCost} currency={stock.data!.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount value={r.totalCost} currency={stock.data!.currency} />
                      </TableCell>
                      <TableCell>
                        {r.belowReorder ? (
                          <span className="flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="h-3.5 w-3.5" /> below {qty(r.reorderLevel!)}
                          </span>
                        ) : r.reorderLevel ? (
                          <span className="text-xs text-muted-foreground">
                            at {qty(r.reorderLevel)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Total ({stock.data.currency})
                  </TableCell>
                  <TableCell className="tabular text-right font-semibold">
                    {qty(stock.data.totals.quantity)}
                  </TableCell>
                  <TableCell />
                  <TableCell>
                    <Amount
                      value={stock.data.totals.value}
                      currency={stock.data.currency}
                      className="font-semibold"
                    />
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** Inventory valuation: subledger vs. control account(s), plus value per warehouse. */
export function InventoryValuationPage() {
  const { activeCompany } = useSession();
  const [asOf, setAsOf] = React.useState(today());
  const report = useInventoryValuation(asOf, Boolean(asOf));
  const r = report.data;
  return (
    <>
      <PageHeader
        title="Inventory valuation"
        description={`${activeCompany?.name ?? ''} - the inventory subledger tied back to the inventory control account(s) in the general ledger.`}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="valuation-as-of">Ledger balance as of</Label>
              <Input
                id="valuation-as-of"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="w-44"
              />
            </div>
            <p className="pb-2 text-xs text-muted-foreground">
              Stock values are current; the ledger side is the account balance at this date.
            </p>
          </CardContent>
        </Card>
        <Card data-testid="inventory-reconciliation">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {r ? (
                r.reconciled ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
                )
              ) : null}
              Subledger vs. general ledger
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!r ? (
              <TableSkeleton columns={2} rows={3} />
            ) : (
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                <dt className="text-muted-foreground">Stock value</dt>
                <dd>
                  <Amount value={r.totalSubledger} currency={r.currency} />
                </dd>
                <dt className="text-muted-foreground">Ledger balance</dt>
                <dd>
                  <Amount value={r.totalLedger} currency={r.currency} />
                </dd>
                <dt
                  className={cn('font-medium', r.reconciled ? 'text-success' : 'text-destructive')}
                >
                  {r.reconciled ? 'Reconciled' : 'Difference'}
                </dt>
                <dd>
                  <Amount
                    value={r.accounts.reduce((s, a) => s + Number(a.difference), 0).toFixed(4)}
                    currency={r.currency}
                    className={cn('font-semibold', !r.reconciled && 'text-destructive')}
                    zeroAsDash
                  />
                </dd>
              </dl>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By inventory account</CardTitle>
            <CardDescription>
              Products post to the account on the product, else the category, else the company
              mapping.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!r ? (
              <TableSkeleton columns={4} rows={2} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Account</TableHead>
                    <TableHead className="text-right">Subledger</TableHead>
                    <TableHead className="text-right">Ledger</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.accounts.map((a) => (
                    <TableRow key={a.accountId}>
                      <TableCell>
                        <Link
                          href={`/accounting/general-ledger?accountId=${a.accountId}`}
                          className="hover:underline"
                        >
                          <span className="font-mono text-xs text-muted-foreground">{a.code}</span>{' '}
                          {a.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Amount value={a.subledgerValue} currency={r.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount value={a.ledgerBalance} currency={r.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount
                          value={a.difference}
                          currency={r.currency}
                          zeroAsDash
                          className={a.reconciled ? '' : 'text-destructive'}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By warehouse</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!r ? (
              <TableSkeleton columns={3} rows={2} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Warehouse</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.byWarehouse.map((w) => (
                    <TableRow key={w.warehouseId}>
                      <TableCell>
                        <span className="font-mono text-xs text-muted-foreground">{w.code}</span>{' '}
                        {w.name}
                      </TableCell>
                      <TableCell className="tabular text-right">{qty(w.quantity)}</TableCell>
                      <TableCell>
                        <Amount value={w.value} currency={r.currency} zeroAsDash />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

type SettingsInput = z.input<typeof inventorySettingsSchema>;

export function InventorySettingsPage() {
  const { hasPermission } = useSession();
  const settings = useInventorySettings();
  const update = useUpdateInventorySettings();
  const canManage = hasPermission(P['inventory-settings.manage']);
  const form = useForm<SettingsInput, unknown, InventorySettingsInput>({
    resolver: zodResolver(inventorySettingsSchema),
    defaultValues: { defaultCostingMethod: 'WEIGHTED_AVERAGE', allowNegativeStock: false },
  });
  React.useEffect(() => {
    if (settings.data)
      form.reset({
        defaultCostingMethod: settings.data.defaultCostingMethod,
        allowNegativeStock: settings.data.allowNegativeStock,
      });
  }, [settings.data, form]);
  if (settings.isLoading || !settings.data) return <Skeleton className="h-48" />;
  return (
    <>
      <PageHeader
        title="Inventory settings"
        description="Costing default for new products and whether stock may go negative."
      />
      <Form {...form}>
        <form
          className="space-y-4"
          noValidate
          onSubmit={form.handleSubmit(async (values) => {
            try {
              await update.mutateAsync(values);
              toast.success('Inventory settings saved.');
            } catch (err) {
              toast.error(describeError(err));
            }
          })}
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Valuation</CardTitle>
              <CardDescription>
                Products without an explicit costing method use this default. Changing it does not
                re-cost existing stock.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="defaultCostingMethod"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default costing method</FormLabel>
                    <Select
                      value={field.value ?? 'WEIGHTED_AVERAGE'}
                      onValueChange={field.onChange}
                      disabled={!canManage}
                    >
                      <FormControl>
                        <SelectTrigger className="w-64">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {COSTING_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m === 'FIFO' ? 'FIFO (first in, first out)' : 'Weighted average'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="allowNegativeStock"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={Boolean(field.value)}
                        onCheckedChange={(v) => field.onChange(v === true)}
                        disabled={!canManage}
                      />
                    </FormControl>
                    <div>
                      <FormLabel className="font-normal">Allow negative stock</FormLabel>
                      <p className="text-xs text-muted-foreground">
                        Issues beyond the quantity on hand are costed at the average, standard or
                        purchase cost. Off by default: an invoice for goods not in stock is
                        rejected.
                      </p>
                    </div>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>
          {canManage ? (
            <div className="flex justify-end">
              <Button type="submit" loading={update.isPending}>
                Save settings
              </Button>
            </div>
          ) : null}
        </form>
      </Form>
    </>
  );
}
