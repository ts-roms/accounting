'use client';
import * as React from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { P, TAX_APPLIES_TO, TAX_KINDS, TAX_REPORTING_CATEGORIES } from '@accounting/types';
import { createTaxCodeSchema, type CreateTaxCodeInput } from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
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
import { useCreateTaxCode, useTaxCodes, useUpdateTaxCode } from '@/lib/api/budgeting-tax-hooks';
import type { TaxCode } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { AccountCombobox } from '@/components/accounting/primitives';

type TaxCodeFormInput = z.input<typeof createTaxCodeSchema>;

const pct = (v: string | null) => (v === null ? '-' : `${Number(v)}%`);

export function TaxCodesPage() {
  const { hasPermission } = useSession();
  const codes = useTaxCodes(undefined, undefined);
  const update = useUpdateTaxCode();
  const [dialog, setDialog] = React.useState<{ open: boolean; code?: TaxCode }>({ open: false });
  const canManage = hasPermission(P['tax.manage']);
  return (
    <>
      <PageHeader
        title="Tax codes"
        description="Tax rules are data: each code names the accounts the engine posts to on the sales and purchase sides, and its rates are effective-dated so history never changes."
        actions={
          <Can permissions={[P['tax.manage']]}>
            <Button onClick={() => setDialog({ open: true })} data-testid="new-tax-code">
              <Plus /> New tax code
            </Button>
          </Can>
        }
      />
      {codes.isLoading ? (
        <TableSkeleton columns={6} />
      ) : codes.data?.length === 0 ? (
        <EmptyState title="No tax codes" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Applies to</TableHead>
                  <TableHead className="text-right">Current rate</TableHead>
                  <TableHead>Accounts (sales / purchases)</TableHead>
                  <TableHead>Defaults</TableHead>
                  <TableHead className="text-right">Transactions</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage ? <TableHead className="w-24" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.data?.map((c) => (
                  <TableRow key={c.id} data-testid="tax-code-row">
                    <TableCell className="font-mono text-xs">{c.code}</TableCell>
                    <TableCell>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {titleCase(c.reportingCategory)}
                      </div>
                    </TableCell>
                    <TableCell>{c.kind === 'SALES_TAX' ? 'Sales tax' : 'Withholding'}</TableCell>
                    <TableCell>{titleCase(c.appliesTo)}</TableCell>
                    <TableCell className="text-right tabular">{pct(c.currentRate)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {c.salesAccountCode ?? '-'} / {c.purchaseAccountCode ?? '-'}
                    </TableCell>
                    <TableCell className="space-x-1">
                      {c.isDefaultSales ? <Badge variant="outline">Sales</Badge> : null}
                      {c.isDefaultPurchases ? <Badge variant="outline">Purchases</Badge> : null}
                    </TableCell>
                    <TableCell className="text-right tabular">{c.transactionCount}</TableCell>
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
                          onClick={() => setDialog({ open: true, code: c })}
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
      <TaxCodeDialog
        open={dialog.open}
        code={dialog.code}
        onOpenChange={(open) => setDialog({ open })}
      />
    </>
  );
}

function TaxCodeDialog({
  open,
  code,
  onOpenChange,
}: {
  open: boolean;
  code?: TaxCode;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateTaxCode();
  const update = useUpdateTaxCode();
  const defaults = React.useCallback(
    (): TaxCodeFormInput => ({
      code: code?.code ?? '',
      name: code?.name ?? '',
      description: code?.description ?? undefined,
      kind: code?.kind ?? 'SALES_TAX',
      appliesTo: code?.appliesTo ?? 'BOTH',
      reportingCategory: code?.reportingCategory ?? 'TAXABLE',
      salesAccountId: code?.salesAccountId ?? null,
      purchaseAccountId: code?.purchaseAccountId ?? null,
      isDefaultSales: code?.isDefaultSales ?? false,
      isDefaultPurchases: code?.isDefaultPurchases ?? false,
      rates: code?.rates.map((r) => ({
        ratePercent: String(Number(r.ratePercent)),
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
      })) ?? [{ ratePercent: '12', effectiveFrom: '2000-01-01', effectiveTo: null }],
    }),
    [code],
  );
  const form = useForm<TaxCodeFormInput, unknown, CreateTaxCodeInput>({
    resolver: zodResolver(createTaxCodeSchema),
    defaultValues: defaults(),
  });
  const rates = useFieldArray({ control: form.control, name: 'rates' });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const kind = form.watch('kind');
  const appliesTo = form.watch('appliesTo');
  const submit = form.handleSubmit(async (values) => {
    try {
      if (code) {
        const { code: _c, kind: _k, appliesTo: _a, ...rest } = values;
        await update.mutateAsync({ id: code.id, ...rest });
      } else await create.mutateAsync(values);
      toast.success(code ? 'Tax code updated.' : 'Tax code created.');
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  const salesLabel =
    kind === 'WITHHOLDING'
      ? 'Sales side: creditable withholding (asset)'
      : 'Sales side: output tax payable (liability)';
  const purchaseLabel =
    kind === 'WITHHOLDING'
      ? 'Purchase side: withholding tax payable (liability)'
      : 'Purchase side: input tax (asset)';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{code ? `Edit ${code.code}` : 'New tax code'}</DialogTitle>
          <DialogDescription>
            Sales tax is added to a document; withholding is deducted from what the counterparty
            settles. Kind and side are fixed once created.
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
                        disabled={Boolean(code)}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                        data-testid="tax-code-code"
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
                      <Input {...field} data-testid="tax-code-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kind</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={Boolean(code)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TAX_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {k === 'SALES_TAX' ? 'Sales tax' : 'Withholding'}
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
                name="appliesTo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Applies to</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={Boolean(code)}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TAX_APPLIES_TO.map((a) => (
                          <SelectItem key={a} value={a}>
                            {titleCase(a)}
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
                name="reportingCategory"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reporting</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TAX_REPORTING_CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {titleCase(c)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {appliesTo !== 'PURCHASES' ? (
              <FormField
                control={form.control}
                name="salesAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{salesLabel}</FormLabel>
                    <AccountCombobox
                      value={field.value ?? null}
                      onChange={(id) => field.onChange(id)}
                      types={kind === 'WITHHOLDING' ? ['ASSET'] : ['LIABILITY']}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            {appliesTo !== 'SALES' ? (
              <FormField
                control={form.control}
                name="purchaseAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{purchaseLabel}</FormLabel>
                    <AccountCombobox
                      value={field.value ?? null}
                      onChange={(id) => field.onChange(id)}
                      types={kind === 'WITHHOLDING' ? ['LIABILITY'] : ['ASSET']}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            {kind === 'SALES_TAX' ? (
              <div className="flex gap-6">
                {(['isDefaultSales', 'isDefaultPurchases'] as const).map((name) => (
                  <FormField
                    key={name}
                    control={form.control}
                    name={name}
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-2">
                        <FormControl>
                          <Checkbox
                            checked={Boolean(field.value)}
                            onCheckedChange={(v) => field.onChange(Boolean(v))}
                          />
                        </FormControl>
                        <FormLabel className="!mt-0">
                          {name === 'isDefaultSales' ? 'Default on sales' : 'Default on purchases'}
                        </FormLabel>
                      </FormItem>
                    )}
                  />
                ))}
              </div>
            ) : null}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Rates</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    rates.append({
                      ratePercent: '0',
                      effectiveFrom: new Date().toISOString().slice(0, 10),
                      effectiveTo: null,
                    })
                  }
                >
                  <Plus /> Add rate
                </Button>
              </div>
              <FormDescription>
                Windows must not overlap; leave the end blank for the current rate.
              </FormDescription>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-28">Rate %</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rates.fields.map((f, i) => (
                    <TableRow key={f.id} className="hover:bg-transparent">
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`rates.${i}.ratePercent`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  inputMode="decimal"
                                  className="text-right tabular"
                                  {...field}
                                  data-testid="tax-rate"
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`rates.${i}.effectiveFrom`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input type="date" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <FormField
                          control={form.control}
                          name={`rates.${i}.effectiveTo`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  type="date"
                                  {...field}
                                  value={field.value ?? ''}
                                  onChange={(e) => field.onChange(e.target.value || null)}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove rate"
                          disabled={rates.fields.length <= 1}
                          onClick={() => rates.remove(i)}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {form.formState.errors.rates?.root || form.formState.errors.rates?.message ? (
                <p className="text-sm text-destructive">
                  {form.formState.errors.rates.root?.message ?? form.formState.errors.rates.message}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || update.isPending}
                data-testid="tax-code-save"
              >
                {code ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
