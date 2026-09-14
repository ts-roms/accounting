'use client';
import * as React from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import type { z } from 'zod';
import { Money } from '@accounting/money';
import { SUBLEDGER_DOCUMENT_TYPES } from '@accounting/types';
import { createBillSchema, createInvoiceSchema } from '@accounting/validation';
import {
  Button,
  Card,
  CardContent,
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import type { DocumentInput } from '@/lib/api/subledger-hooks';
import type { Party, SubledgerDocumentDetail } from '@/lib/api/types';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { ProductLineCell, productDefaults } from '@/components/inventory/product-line-cell';
import { DimensionsPopover, TaxCodeSelect, estimateRate } from '@/components/dimensions/pickers';
import { useTaxCodes } from '@/lib/api/budgeting-tax-hooks';
import { useResolvedRate } from '@/lib/api/enterprise-hooks';
import { SuggestAccountButton } from '@/components/ai/suggest-account';
import { PartyCombobox } from './party-combobox';

/** Superset of the invoice and bill inputs; the resolver enforces the side-specific schema. */
export type DocumentFormInput = z.input<typeof createInvoiceSchema> &
  z.input<typeof createBillSchema>;
type DocumentFormOutput = z.output<typeof createInvoiceSchema> & z.output<typeof createBillSchema>;

const emptyLine = (accountId = ''): DocumentFormInput['lines'][number] => ({
  description: '',
  quantity: '1',
  unitPrice: '0',
  discountPercent: '0',
  accountId,
  productId: null,
  warehouseId: null,
  taxCodeId: null,
  withholdingTaxCodeId: null,
});

/** "1250.5000" -> "1250.5" for editing. */
function trim(amount: string): string {
  if (!amount.includes('.')) return amount;
  const t = amount.replace(/0+$/, '').replace(/\.$/, '');
  return t === '' || t === '-' ? '0' : t;
}

function safeMoney(value: string, currency: string): Money {
  try {
    return Money.isValidDecimalString(value) ? Money.parse(value, currency) : Money.zero(currency);
  } catch {
    return Money.zero(currency);
  }
}

function lineAmount(
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

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toFormValues(
  cfg: SubledgerConfig,
  doc?: SubledgerDocumentDetail,
  partyId?: string,
): DocumentFormInput {
  if (!doc) {
    return {
      customerId: cfg.side === 'AR' ? (partyId ?? '') : '',
      vendorId: cfg.side === 'AP' ? (partyId ?? '') : '',
      documentType: 'INVOICE',
      documentDate: today(),
      dueDate: undefined,
      reference: '',
      description: '',
      vendorInvoiceNumber: '',
      scheduledPaymentDate: null,
      lines: [emptyLine()],
    };
  }
  return {
    customerId: doc.customerId ?? '',
    vendorId: doc.vendorId ?? '',
    documentType: doc.documentType,
    documentDate: doc.documentDate,
    dueDate: doc.dueDate,
    reference: doc.reference ?? '',
    description: doc.description ?? '',
    vendorInvoiceNumber: doc.vendorInvoiceNumber ?? '',
    scheduledPaymentDate: doc.scheduledPaymentDate ?? null,
    branchId: doc.branchId,
    lines: doc.lines.map((l) => ({
      description: l.description,
      quantity: trim(l.quantity),
      unitPrice: trim(l.unitPrice),
      discountPercent: trim(l.discountPercent),
      accountId: l.accountId,
      branchId: l.branchId,
      orderLineId: l.orderLineId ?? undefined,
      productId: l.productId,
      warehouseId: l.warehouseId,
      lotNumber: l.lotNumber ?? undefined,
      serialNumbers: l.serialNumbers.length ? l.serialNumbers : undefined,
      taxCodeId: l.taxCodeId,
      withholdingTaxCodeId: l.withholdingTaxCodeId,
      departmentId: l.departmentId,
      costCenterId: l.costCenterId,
      projectId: l.projectId,
    })),
  };
}

export function DocumentForm({
  cfg,
  document,
  initialPartyId,
  currency: baseCurrency,
  submitting,
  onSubmit,
  onCancel,
}: {
  cfg: SubledgerConfig;
  document?: SubledgerDocumentDetail;
  initialPartyId?: string;
  /** Company base currency; the document itself is in the party's currency. */
  currency: string;
  submitting: boolean;
  onSubmit: (values: DocumentInput) => Promise<void>;
  onCancel: () => void;
}) {
  const schema = cfg.side === 'AR' ? createInvoiceSchema : createBillSchema;
  const form = useForm<DocumentFormInput, unknown, DocumentFormOutput>({
    // Each side's schema only validates (and keeps) its own fields; the other side's are stripped.
    resolver: zodResolver(schema as unknown as z.ZodType<DocumentFormOutput, DocumentFormInput>),
    defaultValues: toFormValues(cfg, document, initialPartyId),
    mode: 'onBlur',
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const watchedLines = useWatch({ control: form.control, name: 'lines' });
  const documentType = useWatch({ control: form.control, name: 'documentType' });
  const [party, setParty] = React.useState<Party | null>(null);
  // Foreign-currency documents: amounts stay in the party's currency; the ledger converts at the rate.
  const currency = document?.currency ?? party?.currency ?? baseCurrency;
  const documentDate = useWatch({ control: form.control, name: 'documentDate' });
  const rateOverride = useWatch({ control: form.control, name: 'exchangeRate' });
  const tableRate = useResolvedRate(currency, baseCurrency, documentDate || today());
  const effectiveRate = rateOverride || document?.exchangeRate || tableRate.data?.rate || null;
  const partyField = cfg.side === 'AR' ? 'customerId' : 'vendorId';
  const partyDefaultAccount = party?.[cfg.defaultLineAccountField] ?? null;

  const amounts = (watchedLines ?? []).map((l) =>
    lineAmount(l?.quantity ?? '1', l?.unitPrice ?? '0', l?.discountPercent ?? '0', currency),
  );
  const subtotal = Money.sum(amounts, currency);
  const taxSide = cfg.side === 'AR' ? 'SALES' : 'PURCHASES';
  const taxCodes = useTaxCodes(taxSide);
  const taxTotal = Money.sum(
    amounts.map((a, i) =>
      a.multiply(estimateRate(taxCodes.data, watchedLines?.[i]?.taxCodeId)).multiply('0.01'),
    ),
    currency,
  );
  const withholdingTotal = Money.sum(
    amounts.map((a, i) =>
      a
        .multiply(estimateRate(taxCodes.data, watchedLines?.[i]?.withholdingTaxCodeId))
        .multiply('0.01'),
    ),
    currency,
  );
  const total = subtotal.add(taxTotal).subtract(withholdingTotal);
  const hasTaxCodes = (taxCodes.data?.length ?? 0) > 0;

  // When a party is picked on a new document, default the due date from its terms and
  // the first empty line account from its default account.
  const onPartyChange = (id: string, p: Party) => {
    form.setValue(partyField, id, { shouldDirty: true, shouldValidate: true });
    setParty(p);
    if (!document) {
      const date = form.getValues('documentDate') || today();
      form.setValue('dueDate', addDays(date, p.paymentTermsDays));
      const acct = p[cfg.defaultLineAccountField];
      if (acct) {
        form.getValues('lines').forEach((l, i) => {
          if (!l.accountId) form.setValue(`lines.${i}.accountId`, acct);
        });
      }
    }
  };

  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (form.formState.isDirty && !submitting) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [form.formState.isDirty, submitting]);

  const submit = form.handleSubmit(async (values) => {
    await onSubmit(values as DocumentInput);
  });

  const typeLabel = (t: (typeof SUBLEDGER_DOCUMENT_TYPES)[number]) =>
    t === 'INVOICE'
      ? cfg.document.singular
      : t === 'CREDIT_NOTE'
        ? cfg.document.creditNoteLabel
        : cfg.document.debitNoteLabel;

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
                  <FormLabel>{cfg.party.singular}</FormLabel>
                  <PartyCombobox
                    cfg={cfg}
                    value={field.value}
                    onChange={onPartyChange}
                    disabled={Boolean(document)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="documentType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select
                    value={field.value ?? 'INVOICE'}
                    onValueChange={field.onChange}
                    disabled={Boolean(document)}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="document-type">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SUBLEDGER_DOCUMENT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {typeLabel(t)}
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
              name="documentDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      {...field}
                      onChange={(e) => {
                        field.onChange(e);
                        if (!document && party && e.target.value)
                          form.setValue('dueDate', addDays(e.target.value, party.paymentTermsDays));
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Due date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.value || undefined)}
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
                  <FormLabel>{cfg.side === 'AR' ? 'Reference / PO' : 'Reference'}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {currency !== baseCurrency ? (
              <FormField
                control={form.control}
                name="exchangeRate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Rate: 1 {currency} = ? {baseCurrency}
                    </FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        className="tabular"
                        {...field}
                        value={field.value ?? ''}
                        placeholder={
                          tableRate.data?.rate ?? (tableRate.isError ? 'No rate on file' : '')
                        }
                        onChange={(e) => field.onChange(e.target.value || undefined)}
                        data-testid="exchange-rate"
                      />
                    </FormControl>
                    <FormDescription>
                      {effectiveRate
                        ? `Total ${total.toString()} ${currency} = ${total.convert(baseCurrency, effectiveRate).toString()} ${baseCurrency}`
                        : 'Add a rate in Accounting > Exchange rates or enter one here.'}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            {cfg.side === 'AP' ? (
              <>
                <FormField
                  control={form.control}
                  name="vendorInvoiceNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Vendor invoice no.</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Supplier's number"
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
                  name="scheduledPaymentDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scheduled payment</FormLabel>
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
              </>
            ) : null}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className={cfg.side === 'AP' ? 'md:col-span-4' : 'md:col-span-2'}>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Shown on the document and the journal"
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
                <TableHead className="min-w-[220px]">Product / stock</TableHead>
                <TableHead className="min-w-[220px]">Description</TableHead>
                <TableHead className="min-w-[240px]">
                  {cfg.side === 'AR' ? 'Revenue account' : 'Expense account'}
                </TableHead>
                <TableHead className="w-24 text-right">Qty</TableHead>
                <TableHead className="w-32 text-right">Unit price</TableHead>
                <TableHead className="w-20 text-right">Disc %</TableHead>
                <TableHead className="w-32 text-right">Amount</TableHead>
                {hasTaxCodes ? <TableHead className="w-36">Tax</TableHead> : null}
                <TableHead className="w-12" />
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.fields.map((field, index) => (
                <TableRow key={field.id} className="hover:bg-transparent">
                  <TableCell className="text-xs text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <ProductLineCell
                      side={cfg.side}
                      productId={watchedLines?.[index]?.productId}
                      warehouseId={watchedLines?.[index]?.warehouseId}
                      lotNumber={watchedLines?.[index]?.lotNumber}
                      serialNumbers={watchedLines?.[index]?.serialNumbers}
                      onProduct={(id, p) => {
                        form.setValue(`lines.${index}.productId`, id, { shouldDirty: true });
                        if (!id) form.setValue(`lines.${index}.warehouseId`, null);
                        const d = productDefaults(p, cfg.side);
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
                      onLot={(lot) =>
                        form.setValue(`lines.${index}.lotNumber`, lot || undefined, {
                          shouldDirty: true,
                        })
                      }
                      onSerials={(serials) =>
                        form.setValue(
                          `lines.${index}.serialNumbers`,
                          serials.length ? serials : undefined,
                          { shouldDirty: true },
                        )
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
                            <Input
                              placeholder="What was sold or bought"
                              {...f}
                              value={f.value ?? ''}
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
                      name={`lines.${index}.accountId`}
                      render={({ field: f }) => (
                        <FormItem>
                          <div className="flex items-center gap-1">
                            <AccountCombobox
                              value={f.value}
                              onChange={(id) => f.onChange(id)}
                              types={cfg.lineAccountTypes}
                              className="flex-1"
                            />
                            <SuggestAccountButton
                              description={watchedLines?.[index]?.description ?? ''}
                              side={cfg.side === 'AR' ? 'SALE' : 'PURCHASE'}
                              partyId={form.watch(partyField)}
                              onSuggest={(sug) => {
                                f.onChange(sug.accountId);
                                if (sug.taxCodeId && !watchedLines?.[index]?.taxCodeId)
                                  form.setValue(`lines.${index}.taxCodeId`, sug.taxCodeId, {
                                    shouldDirty: true,
                                  });
                              }}
                            />
                          </div>
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
                                  if (e.target.value === '0' || e.target.value === '1')
                                    e.target.select();
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
                      value={(amounts[index] ?? Money.zero(currency)).toString()}
                      currency={currency}
                    />
                  </TableCell>
                  {hasTaxCodes ? (
                    <TableCell className="space-y-1">
                      <TaxCodeSelect
                        side={taxSide}
                        kind="SALES_TAX"
                        value={watchedLines?.[index]?.taxCodeId}
                        onChange={(id) =>
                          form.setValue(`lines.${index}.taxCodeId`, id, { shouldDirty: true })
                        }
                        testId="line-tax-code"
                      />
                      <TaxCodeSelect
                        side={taxSide}
                        kind="WITHHOLDING"
                        value={watchedLines?.[index]?.withholdingTaxCodeId}
                        onChange={(id) =>
                          form.setValue(`lines.${index}.withholdingTaxCodeId`, id, {
                            shouldDirty: true,
                          })
                        }
                        testId="line-withholding-code"
                      />
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <DimensionsPopover
                      value={{
                        departmentId: watchedLines?.[index]?.departmentId,
                        costCenterId: watchedLines?.[index]?.costCenterId,
                        projectId: watchedLines?.[index]?.projectId,
                      }}
                      onChange={(next) => {
                        form.setValue(`lines.${index}.departmentId`, next.departmentId ?? null, {
                          shouldDirty: true,
                        });
                        form.setValue(`lines.${index}.costCenterId`, next.costCenterId ?? null, {
                          shouldDirty: true,
                        });
                        form.setValue(`lines.${index}.projectId`, next.projectId ?? null, {
                          shouldDirty: true,
                        });
                      }}
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
                <TableCell colSpan={7}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => lines.append(emptyLine(partyDefaultAccount ?? ''))}
                  >
                    <Plus /> Add line
                  </Button>
                </TableCell>
                <TableCell colSpan={hasTaxCodes ? 4 : 3}>
                  <dl className="ml-auto grid w-72 grid-cols-[1fr_auto] gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Subtotal</dt>
                    <dd>
                      <Amount value={subtotal.toString()} currency={currency} />
                    </dd>
                    {hasTaxCodes ? (
                      <>
                        <dt className="text-muted-foreground">Tax (est.)</dt>
                        <dd>
                          <Amount value={taxTotal.toString()} currency={currency} zeroAsDash />
                        </dd>
                        <dt className="text-muted-foreground">Withholding (est.)</dt>
                        <dd>
                          <Amount
                            value={
                              withholdingTotal.isZero() ? '0' : withholdingTotal.negate().toString()
                            }
                            currency={currency}
                            zeroAsDash
                          />
                        </dd>
                      </>
                    ) : null}
                    <dt className="font-semibold">Total</dt>
                    <dd>
                      <span data-testid="doc-total">
                        <Amount
                          value={total.toString()}
                          currency={currency}
                          className="font-semibold"
                        />
                      </span>
                    </dd>
                  </dl>
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        {form.formState.errors.lines?.root || form.formState.errors.lines?.message ? (
          <p className="text-xs text-destructive">
            {String(
              form.formState.errors.lines.root?.message ?? form.formState.errors.lines.message,
            )}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {documentType === 'CREDIT_NOTE'
            ? `A ${cfg.document.creditNoteLabel.toLowerCase()} reduces what is ${cfg.side === 'AR' ? 'owed to you' : 'owed to the supplier'}; apply it to open ${cfg.document.plural.toLowerCase()} after posting.`
            : `Saving creates a draft. Approve then post to record the ${cfg.side === 'AR' ? 'receivable' : 'payable'} in the ledger.`}
        </p>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={total.isZero()}>
            {document ? 'Save changes' : 'Save draft'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
