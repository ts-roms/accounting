'use client';
import * as React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Money } from '@accounting/money';
import { PAYMENT_METHODS, PAYMENT_TYPES } from '@accounting/types';
import { createPaymentSchema, type CreatePaymentInput } from '@accounting/validation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
} from '@accounting/ui';
import { useDocuments } from '@/lib/api/subledger-hooks';
import type { SubledgerPaymentDetail } from '@/lib/api/types';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { AllocationEditor, safeMoney, trimAmount } from './document-detail';
import { PartyCombobox } from './party-combobox';
import { useParty } from '@/lib/api/subledger-hooks';
import { useResolvedRate } from '@/lib/api/enterprise-hooks';

export type PaymentFormInput = z.input<typeof createPaymentSchema>;

function toFormValues(payment?: SubledgerPaymentDetail, partyId?: string): PaymentFormInput {
  if (!payment) {
    return {
      partyId: partyId ?? '',
      paymentType: 'PAYMENT',
      paymentDate: today(),
      amount: '0',
      method: 'BANK_TRANSFER',
      cashAccountId: '',
      reference: '',
      memo: '',
      allocations: [],
    };
  }
  return {
    partyId: payment.customerId ?? payment.vendorId ?? '',
    paymentType: payment.paymentType,
    paymentDate: payment.paymentDate,
    amount: trimAmount(payment.amount),
    method: payment.method,
    cashAccountId: payment.cashAccountId,
    reference: payment.reference ?? '',
    memo: payment.memo ?? '',
    allocations: [],
  };
}

export function PaymentForm({
  cfg,
  payment,
  initialPartyId,
  currency: baseCurrency,
  submitting,
  onSubmit,
  onCancel,
}: {
  cfg: SubledgerConfig;
  payment?: SubledgerPaymentDetail;
  initialPartyId?: string;
  /** Company base currency; the payment is in the party's currency. */
  currency: string;
  submitting: boolean;
  onSubmit: (values: CreatePaymentInput) => Promise<void>;
  onCancel: () => void;
}) {
  const form = useForm<PaymentFormInput, unknown, CreatePaymentInput>({
    resolver: zodResolver(createPaymentSchema),
    defaultValues: toFormValues(payment, initialPartyId),
    mode: 'onBlur',
  });
  const partyId = useWatch({ control: form.control, name: 'partyId' });
  const paymentType = useWatch({ control: form.control, name: 'paymentType' });
  const amountText = useWatch({ control: form.control, name: 'amount' });
  const isRefund = paymentType === 'REFUND';
  // Foreign-currency payments: amounts in the party's currency, converted at the rate on posting.
  const party = useParty(cfg, partyId || null);
  const currency = payment?.currency ?? party.data?.currency ?? baseCurrency;
  const paymentDate = useWatch({ control: form.control, name: 'paymentDate' });
  const rateOverride = useWatch({ control: form.control, name: 'exchangeRate' });
  const tableRate = useResolvedRate(currency, baseCurrency, paymentDate || today());
  const effectiveRate = rateOverride || payment?.exchangeRate || tableRate.data?.rate || null;
  // Draft allocations are re-created on save, so the editor starts from the existing ones.
  const [amounts, setAmounts] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      (payment?.allocations ?? []).map((a) => [
        a.invoiceId ?? a.billId ?? '',
        trimAmount(a.amount),
      ]),
    ),
  );
  const openDocs = useDocuments(
    cfg,
    {
      partyId: partyId || undefined,
      openOnly: true,
      pageSize: 200,
      sortBy: 'dueDate',
      sortDir: 'asc',
    },
    Boolean(partyId) && !isRefund,
  );
  const rows = React.useMemo(
    () => (openDocs.data?.items ?? []).filter((d) => d.documentType !== 'CREDIT_NOTE'),
    [openDocs.data],
  );
  const amount = safeMoney(amountText ?? '0', currency);
  const allocated = Money.sum(
    Object.values(amounts).map((v) => safeMoney(v, currency)),
    currency,
  );
  const unallocated = amount.subtract(allocated);
  const overAllocated =
    unallocated.isNegative() ||
    rows.some((r) =>
      safeMoney(amounts[r.id] ?? '0', currency).greaterThan(Money.parse(r.balance, currency)),
    );

  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (form.formState.isDirty && !submitting) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [form.formState.isDirty, submitting]);

  const submit = form.handleSubmit(async (values) => {
    const allocations = isRefund
      ? []
      : Object.entries(amounts)
          .filter(([id, v]) => rows.some((r) => r.id === id) && safeMoney(v, currency).isPositive())
          .map(([documentId, v]) => ({ documentId, amount: safeMoney(v, currency).toString() }));
    await onSubmit({ ...values, allocations });
  });

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Card>
          <CardContent className="grid gap-3 p-4 md:grid-cols-4">
            <FormField
              control={form.control}
              name="partyId"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>{cfg.party.singular}</FormLabel>
                  <PartyCombobox
                    cfg={cfg}
                    value={field.value}
                    onChange={(id) => {
                      field.onChange(id);
                      setAmounts({});
                    }}
                    disabled={Boolean(payment)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select
                    value={field.value ?? 'PAYMENT'}
                    onValueChange={(v) => {
                      field.onChange(v);
                      if (v === 'REFUND') setAmounts({});
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAYMENT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t === 'PAYMENT' ? cfg.payment.singular : 'Refund'}
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
              name="paymentDate"
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
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount ({currency})</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="decimal"
                      className="tabular text-right"
                      data-testid="payment-amount"
                      {...field}
                      onFocus={(e) => {
                        if (e.target.value === '0') e.target.select();
                      }}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        field.onChange(v === '' ? '0' : v);
                        field.onBlur();
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Method</FormLabel>
                  <Select value={field.value ?? 'BANK_TRANSFER'} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PAYMENT_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {titleCase(m)}
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
              name="cashAccountId"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>
                    {isRefund !== (cfg.side === 'AP') ? 'Paid from' : 'Deposited to'}
                  </FormLabel>
                  <AccountCombobox
                    value={field.value}
                    onChange={(id) => field.onChange(id)}
                    types={['ASSET']}
                    subtypes={['CASH', 'BANK']}
                    placeholder="Cash or bank account"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            {currency !== baseCurrency ? (
              <FormField
                control={form.control}
                name="exchangeRate"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
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
                        ? `${amount.toString()} ${currency} = ${amount.convert(baseCurrency, effectiveRate).toString()} ${baseCurrency}; settling documents booked at other rates posts realized FX.`
                        : 'Add a rate in Accounting > Exchange rates or enter one here.'}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Reference</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Check / transfer number"
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
              name="memo"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Memo</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Shown on the journal entry"
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

        {isRefund ? (
          <p className="text-xs text-muted-foreground">
            A refund returns unapplied credit (open credit notes or on-account{' '}
            {cfg.payment.plural.toLowerCase()}) to the {cfg.party.singular.toLowerCase()}. It cannot
            be allocated to {cfg.document.plural.toLowerCase()}.
          </p>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Allocate to open {cfg.document.plural.toLowerCase()}</CardTitle>
              <CardDescription>
                Anything not allocated stays on account and can be applied later. Allocations take
                effect when the {cfg.payment.singular.toLowerCase()} is posted.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {partyId ? (
                <AllocationEditor
                  cfg={cfg}
                  rows={rows}
                  currency={currency}
                  amounts={amounts}
                  onChange={setAmounts}
                  available={amount}
                  isLoading={openDocs.isLoading}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Choose a {cfg.party.singular.toLowerCase()} to see open{' '}
                  {cfg.document.plural.toLowerCase()}.
                </p>
              )}
              <div className="mt-3 flex justify-end gap-6 text-sm">
                <span>
                  On account:{' '}
                  <Amount
                    value={unallocated.toString()}
                    currency={currency}
                    className={
                      unallocated.isNegative()
                        ? 'inline font-semibold text-destructive'
                        : 'inline font-semibold'
                    }
                  />
                </span>
              </div>
              {unallocated.isNegative() ? (
                <p className="mt-1 text-right text-xs text-destructive">
                  Allocations exceed the {cfg.payment.singular.toLowerCase()} amount.
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            loading={submitting}
            disabled={!amount.isPositive() || overAllocated}
          >
            {payment ? 'Save changes' : 'Save draft'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
