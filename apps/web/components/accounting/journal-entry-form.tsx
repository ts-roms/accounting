'use client';
import * as React from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { DimensionsPopover } from '@/components/dimensions/pickers';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import type { z } from 'zod';
import { Money } from '@accounting/money';
import { JOURNAL_TYPES, type JournalType } from '@accounting/types';
import { createJournalEntrySchema, type CreateJournalEntryInput } from '@accounting/validation';
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
  cn,
} from '@accounting/ui';
import type { JournalEntryDetail } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { AccountCombobox, Amount, today } from './primitives';

export type JournalFormInput = z.input<typeof createJournalEntrySchema>;

const emptyLine = (): JournalFormInput['lines'][number] => ({
  accountId: '',
  description: '',
  debit: '0',
  credit: '0',
  departmentId: null,
  costCenterId: null,
  projectId: null,
});

export interface JournalPrefill {
  journalType?: JournalType;
  description?: string;
  /** Account of the first line (e.g. the suspense account being cleared). */
  accountId?: string;
}

function toFormValues(entry?: JournalEntryDetail, prefill?: JournalPrefill): JournalFormInput {
  if (!entry) {
    const first = emptyLine();
    if (prefill?.accountId) first.accountId = prefill.accountId;
    return {
      entryDate: today(),
      documentDate: null,
      description: prefill?.description ?? '',
      reference: '',
      journalType: prefill?.journalType ?? 'GENERAL',
      transactionCurrency: undefined,
      exchangeRate: undefined,
      autoReverseDate: null,
      lines: [first, emptyLine()],
    };
  }
  return {
    entryDate: entry.entryDate,
    documentDate: entry.documentDate,
    description: entry.description,
    reference: entry.reference ?? '',
    journalType: entry.journalType,
    branchId: entry.branchId,
    transactionCurrency: entry.transactionCurrency ?? undefined,
    exchangeRate: entry.exchangeRate ? trim(entry.exchangeRate) : undefined,
    autoReverseDate: entry.autoReverseDate,
    // Foreign entries are edited in the currency they were entered in.
    lines: entry.lines.map((l) => ({
      accountId: l.accountId,
      description: l.description ?? '',
      debit: trim(l.foreignDebit ?? l.debit),
      credit: trim(l.foreignCredit ?? l.credit),
      branchId: l.branchId,
      departmentId: l.departmentId,
      costCenterId: l.costCenterId,
      projectId: l.projectId,
    })),
  };
}

/** "1250.5000" -> "1250.5" for editing; "0.0000" -> "0". */
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

export function JournalEntryForm({
  entry,
  prefill,
  currency: currencyProp,
  submitting,
  onSubmit,
  onCancel,
}: {
  entry?: JournalEntryDetail;
  prefill?: JournalPrefill;
  currency: string;
  submitting: boolean;
  onSubmit: (values: CreateJournalEntryInput) => Promise<void>;
  onCancel: () => void;
}) {
  const form = useForm<JournalFormInput, unknown, CreateJournalEntryInput>({
    resolver: zodResolver(createJournalEntrySchema),
    defaultValues: toFormValues(entry, prefill),
    mode: 'onBlur',
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const baseCurrency = currencyProp;
  const txCurrency = (useWatch({ control: form.control, name: 'transactionCurrency' }) ||
    '') as string;
  const foreign = txCurrency.length === 3 && txCurrency !== baseCurrency;
  // Totals are shown in the currency the lines are entered in.
  const currency = foreign ? txCurrency : baseCurrency;
  const journalType = useWatch({ control: form.control, name: 'journalType' });
  // useWatch re-renders on every keystroke in any line; the sums are cheap.
  const watched = useWatch({ control: form.control, name: 'lines' });
  const debit = Money.sum(
    (watched ?? []).map((l) => safeMoney(l?.debit ?? '0', currency)),
    currency,
  );
  const credit = Money.sum(
    (watched ?? []).map((l) => safeMoney(l?.credit ?? '0', currency)),
    currency,
  );
  const totals = { debit, credit, difference: debit.subtract(credit) };
  const balanced = totals.difference.isZero() && !totals.debit.isZero();

  // Unsaved-change protection.
  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (form.formState.isDirty && !submitting) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [form.formState.isDirty, submitting]);

  const submit = form.handleSubmit(async (values) => {
    await onSubmit(values);
  });

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Card>
          <CardContent className="grid gap-3 p-4 md:grid-cols-4">
            <FormField
              control={form.control}
              name="entryDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Entry date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="journalType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Journal type</FormLabel>
                  <Select value={field.value ?? 'GENERAL'} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {JOURNAL_TYPES.filter((t) => t !== 'REVERSAL' && t !== 'CLOSING').map((t) => (
                        <SelectItem key={t} value={t}>
                          {titleCase(t)}
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
              name="reference"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Reference</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Source document number"
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
              name="description"
              render={({ field }) => (
                <FormItem className="md:col-span-4">
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input placeholder="What this entry records" autoFocus {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="documentDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Document date</FormLabel>
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
              name="transactionCurrency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={baseCurrency}
                      maxLength={3}
                      data-testid="je-currency"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.value.toUpperCase() || undefined)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="exchangeRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rate to {baseCurrency}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={foreign ? 'From the rate table' : 'n/a'}
                      disabled={!foreign}
                      inputMode="decimal"
                      data-testid="je-rate"
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
              name="autoReverseDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Auto-reverse on{journalType === 'ACCRUAL' ? '' : ' (optional)'}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      data-testid="je-auto-reverse"
                      {...field}
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.value || null)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {foreign ? (
              <p className="text-xs text-muted-foreground md:col-span-4">
                Lines are entered in {txCurrency}; the ledger stores the {baseCurrency} equivalent
                at the rate above (or the organization rate on the entry date) and keeps the{' '}
                {txCurrency} amounts beside it.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="rounded-md border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10">#</TableHead>
                <TableHead className="min-w-[300px]">Account</TableHead>
                <TableHead>Line description</TableHead>
                <TableHead className="w-40 text-right">Debit</TableHead>
                <TableHead className="w-40 text-right">Credit</TableHead>
                <TableHead className="w-12" />
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.fields.map((field, index) => (
                <TableRow key={field.id} className="hover:bg-transparent">
                  <TableCell className="text-xs text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>
                    <FormField
                      control={form.control}
                      name={`lines.${index}.accountId`}
                      render={({ field: f }) => (
                        <FormItem>
                          <AccountCombobox value={f.value} onChange={(id) => f.onChange(id)} />
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  <TableCell>
                    <FormField
                      control={form.control}
                      name={`lines.${index}.description`}
                      render={({ field: f }) => (
                        <FormItem>
                          <FormControl>
                            <Input placeholder="Optional" {...f} value={f.value ?? ''} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </TableCell>
                  {(['debit', 'credit'] as const).map((side) => (
                    <TableCell key={side}>
                      <FormField
                        control={form.control}
                        name={`lines.${index}.${side}`}
                        render={({ field: f }) => (
                          <FormItem>
                            <FormControl>
                              <Input
                                inputMode="decimal"
                                className="tabular text-right"
                                {...f}
                                value={f.value ?? ''}
                                onFocus={(e) => {
                                  if (e.target.value === '0') e.target.select();
                                }}
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  f.onChange(v === '' ? '0' : v);
                                  if (v !== '' && v !== '0')
                                    form.setValue(
                                      `lines.${index}.${side === 'debit' ? 'credit' : 'debit'}`,
                                      '0',
                                    );
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
                    <DimensionsPopover
                      value={{
                        departmentId: watched?.[index]?.departmentId,
                        costCenterId: watched?.[index]?.costCenterId,
                        projectId: watched?.[index]?.projectId,
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
                      disabled={lines.fields.length <= 2}
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
                <TableCell colSpan={3}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => lines.append(emptyLine())}
                  >
                    <Plus /> Add line
                  </Button>
                </TableCell>
                <TableCell>
                  <Amount
                    value={totals.debit.toString()}
                    currency={currency}
                    className="font-semibold"
                  />
                </TableCell>
                <TableCell>
                  <Amount
                    value={totals.credit.toString()}
                    currency={currency}
                    className="font-semibold"
                  />
                </TableCell>
                <TableCell />
              </TableRow>
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={3}
                  className={cn('text-xs', balanced ? 'text-success' : 'text-destructive')}
                >
                  {balanced
                    ? 'Balanced'
                    : totals.debit.isZero() && totals.credit.isZero()
                      ? 'Enter amounts'
                      : 'Out of balance'}
                </TableCell>
                <TableCell colSpan={2} className="text-right text-xs text-muted-foreground">
                  Difference:{' '}
                  <Amount
                    value={totals.difference.toString()}
                    currency={currency}
                    className="inline"
                  />
                </TableCell>
                <TableCell />
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

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={!balanced}>
            {entry ? 'Save changes' : 'Save draft'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
