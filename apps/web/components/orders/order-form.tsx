'use client';
import * as React from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import type { z } from 'zod';
import { Money } from '@accounting/money';
import { createOrderSchema, type CreateOrderInput } from '@accounting/validation';
import {
  Button,
  Card,
  CardContent,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import type { OrderDetail, Party } from '@/lib/api/types';
import type { OrderConfig } from '@/lib/orders/config';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { ProductLineCell, productDefaults } from '@/components/inventory/product-line-cell';
import { safeMoney, trimAmount } from '@/components/subledger/document-detail';

export type OrderFormInput = z.input<typeof createOrderSchema>;

const emptyLine = (accountId = ''): OrderFormInput['lines'][number] => ({
  description: '',
  quantity: '1',
  unitPrice: '0',
  discountPercent: '0',
  accountId,
  productId: null,
  warehouseId: null,
});

/** Gross, discount and net for one line using the same rounding as the API. */
export function lineNet(
  quantity: string,
  unitPrice: string,
  discountPercent: string,
  currency: string,
): Money {
  const qty = /^\d{1,12}(\.\d{1,4})?$/.test(quantity.trim()) ? quantity.trim() : '0';
  const pct = /^\d{1,3}(\.\d{1,4})?$/.test(discountPercent.trim()) ? discountPercent.trim() : '0';
  const gross = safeMoney(unitPrice, currency).multiply(qty);
  return gross.subtract(gross.multiply(pct).multiply('0.01'));
}

function toFormValues(cfg: OrderConfig, order?: OrderDetail, partyId?: string): OrderFormInput {
  const partyKey = cfg.subledger.side === 'AR' ? 'customerId' : 'vendorId';
  if (!order) {
    return {
      [partyKey]: partyId ?? (cfg.partyOptional ? null : ''),
      orderDate: today(),
      expectedDate: null,
      reference: '',
      description: '',
      notes: '',
      lines: [emptyLine()],
    } as OrderFormInput;
  }
  return {
    customerId: order.customerId ?? undefined,
    vendorId: order.vendorId,
    orderDate: order.orderDate,
    expectedDate: order.expectedDate,
    reference: order.reference ?? '',
    description: order.description ?? '',
    notes: order.notes ?? '',
    branchId: order.branchId,
    lines: order.lines.map((l) => ({
      description: l.description,
      quantity: trimAmount(l.quantity),
      unitPrice: trimAmount(l.unitPrice),
      discountPercent: trimAmount(l.discountPercent),
      accountId: l.accountId,
      branchId: l.branchId,
      productId: l.productId,
      warehouseId: l.warehouseId,
    })),
  };
}

export function OrderForm({
  cfg,
  order,
  initialPartyId,
  currency,
  submitting,
  onSubmit,
  onCancel,
}: {
  cfg: OrderConfig;
  order?: OrderDetail;
  initialPartyId?: string;
  currency: string;
  submitting: boolean;
  onSubmit: (values: CreateOrderInput) => Promise<void>;
  onCancel: () => void;
}) {
  const form = useForm<OrderFormInput, unknown, CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: toFormValues(cfg, order, initialPartyId),
    mode: 'onBlur',
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const watched = useWatch({ control: form.control, name: 'lines' });
  const [party, setParty] = React.useState<Party | null>(null);
  const partyField = cfg.subledger.side === 'AR' ? 'customerId' : 'vendorId';
  const sub = cfg.subledger;
  const defaultAccount = party?.[sub.defaultLineAccountField] ?? null;

  const nets = (watched ?? []).map((l) =>
    lineNet(l?.quantity ?? '1', l?.unitPrice ?? '0', l?.discountPercent ?? '0', currency),
  );
  const gross = Money.sum(
    (watched ?? []).map((l) =>
      safeMoney(l?.unitPrice ?? '0', currency).multiply(
        /^\d{1,12}(\.\d{1,4})?$/.test((l?.quantity ?? '1').trim())
          ? (l?.quantity ?? '1').trim()
          : '0',
      ),
    ),
    currency,
  );
  const total = Money.sum(nets, currency);
  const discount = gross.subtract(total);

  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (form.formState.isDirty && !submitting) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [form.formState.isDirty, submitting]);

  const submit = form.handleSubmit(async (values) => {
    // The party field of the other side is never sent.
    const payload =
      cfg.subledger.side === 'AR'
        ? { ...values, vendorId: undefined }
        : { ...values, customerId: undefined };
    await onSubmit(payload);
  });

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Card>
          <CardContent className="grid gap-3 p-4 md:grid-cols-4">
            <FormField
              control={form.control}
              name={partyField}
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>
                    {sub.party.singular}
                    {cfg.partyOptional ? (
                      <span className="ml-1 font-normal text-muted-foreground">
                        (optional until ordered)
                      </span>
                    ) : null}
                  </FormLabel>
                  <PartyCombobox
                    cfg={sub}
                    value={field.value ?? null}
                    onChange={(id, p) => {
                      field.onChange(id);
                      setParty(p);
                      const acct = p[sub.defaultLineAccountField];
                      if (!order && acct) {
                        form.getValues('lines').forEach((l, i) => {
                          if (!l.accountId) form.setValue(`lines.${i}.accountId`, acct);
                        });
                      }
                    }}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="orderDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="expectedDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{cfg.expectedDateLabel}</FormLabel>
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
            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    {sub.side === 'AR' ? "Customer's reference" : "Vendor's reference"}
                  </FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className="md:col-span-3">
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="What this order is for"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem className="md:col-span-4">
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="Terms, delivery instructions, justification"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">#</TableHead>
                <TableHead className="min-w-[220px]">Product / warehouse</TableHead>
                <TableHead className="min-w-[220px]">Description</TableHead>
                <TableHead className="min-w-[240px]">
                  {sub.side === 'AR' ? 'Revenue account' : 'Expense / asset account'}
                </TableHead>
                <TableHead className="w-24 text-right">Qty</TableHead>
                <TableHead className="w-32 text-right">Unit price</TableHead>
                <TableHead className="w-24 text-right">Disc %</TableHead>
                <TableHead className="w-32 text-right">Amount</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.fields.map((field, index) => (
                <TableRow key={field.id} className="hover:bg-transparent">
                  <TableCell className="text-xs text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <ProductLineCell
                      side={sub.side}
                      productId={watched?.[index]?.productId}
                      warehouseId={watched?.[index]?.warehouseId}
                      onProduct={(id, p) => {
                        form.setValue(`lines.${index}.productId`, id, { shouldDirty: true });
                        if (!id) form.setValue(`lines.${index}.warehouseId`, null);
                        const d = productDefaults(p, sub.side);
                        if (d.description && !form.getValues(`lines.${index}.description`))
                          form.setValue(`lines.${index}.description`, d.description);
                        if (
                          d.unitPrice &&
                          ['0', ''].includes(form.getValues(`lines.${index}.unitPrice`))
                        )
                          form.setValue(`lines.${index}.unitPrice`, d.unitPrice);
                        if (d.accountId) form.setValue(`lines.${index}.accountId`, d.accountId);
                      }}
                      onWarehouse={(id) =>
                        form.setValue(`lines.${index}.warehouseId`, id, { shouldDirty: true })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <FormField
                      control={form.control}
                      name={`lines.${index}.description`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input placeholder="Item or service" {...f} value={f.value ?? ''} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell>
                    <FormField
                      control={form.control}
                      name={`lines.${index}.accountId`}
                      render={({ field: f }) => (
                        <FormItem>
                          <AccountCombobox
                            value={f.value}
                            onChange={(id) => f.onChange(id)}
                            types={sub.lineAccountTypes}
                          />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  {(['quantity', 'unitPrice', 'discountPercent'] as const).map((name) => (
                    <TableCell key={name}>
                      <FormField
                        control={form.control}
                        name={`lines.${index}.${name}`}
                        render={({ field: f }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                inputMode="decimal"
                                className="tabular text-right"
                                {...f}
                                value={f.value ?? ''}
                                onFocus={(e) => {
                                  if (['0', '1'].includes(e.target.value)) e.target.select();
                                }}
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  f.onChange(v === '' ? (name === 'quantity' ? '1' : '0') : v);
                                  f.onBlur();
                                }}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </TableCell>
                  ))}
                  <TableCell>
                    <Amount
                      value={(nets[index] ?? Money.zero(currency)).toString()}
                      currency={currency}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove line"
                      disabled={lines.fields.length <= 1}
                      onClick={() => lines.remove(index)}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => lines.append(emptyLine(defaultAccount ?? ''))}
                  >
                    <Plus /> Add line
                  </Button>
                </TableCell>
                <TableCell colSpan={2} className="text-right text-xs text-muted-foreground">
                  {discount.isZero()
                    ? 'Total'
                    : `Gross ${gross.toString()} less discount ${discount.toString()}`}
                </TableCell>
                <TableCell>
                  <Amount value={total.toString()} currency={currency} className="font-semibold" />
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        {form.formState.errors.lines?.root || form.formState.errors.lines?.message ? (
          <p className="text-xs text-critical">
            {String(
              form.formState.errors.lines.root?.message ?? form.formState.errors.lines.message,
            )}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Orders have no ledger effect. The{' '}
          {cfg.fulfil ? cfg.fulfil.documentSingular.toLowerCase() : 'follow-on document'} raised
          from this order is what gets posted.
        </p>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={total.isZero()}>
            {order ? 'Save changes' : 'Save draft'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
