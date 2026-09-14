'use client';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import { P } from '@accounting/types';
import { purchasingSettingsSchema, type PurchasingSettingsInput } from '@accounting/validation';
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
  FormMessage,
  Input,
  Skeleton,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { usePurchasingSettings, useUpdatePurchasingSettings } from '@/lib/api/orders-hooks';
import { useSession } from '@/lib/auth/session';
import { PageHeader } from '@/components/ui-ext/page';
import { trimAmount } from '@/components/subledger/document-detail';

type FormInput = z.input<typeof purchasingSettingsSchema>;

export function PurchasingSettingsPage() {
  const { hasPermission } = useSession();
  const settings = usePurchasingSettings();
  const update = useUpdatePurchasingSettings();
  const canManage = hasPermission(P['purchasing-settings.manage']);
  const form = useForm<FormInput, unknown, PurchasingSettingsInput>({
    resolver: zodResolver(purchasingSettingsSchema),
    defaultValues: {
      priceTolerancePercent: '0',
      quantityTolerancePercent: '0',
      overReceiptTolerancePercent: '0',
      requirePurchaseOrder: false,
      requireReceiptBeforeBill: true,
    },
  });
  React.useEffect(() => {
    if (settings.data) {
      form.reset({
        priceTolerancePercent: trimAmount(settings.data.priceTolerancePercent),
        quantityTolerancePercent: trimAmount(settings.data.quantityTolerancePercent),
        overReceiptTolerancePercent: trimAmount(settings.data.overReceiptTolerancePercent),
        requirePurchaseOrder: settings.data.requirePurchaseOrder,
        requireReceiptBeforeBill: settings.data.requireReceiptBeforeBill,
      });
    }
  }, [settings.data, form]);

  if (settings.isLoading || !settings.data) return <Skeleton className="h-64" />;

  const percent = (
    name: 'priceTolerancePercent' | 'quantityTolerancePercent' | 'overReceiptTolerancePercent',
    label: string,
    help: string,
  ) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              inputMode="decimal"
              className="tabular w-32 text-right"
              disabled={!canManage}
              {...field}
            />
          </FormControl>
          <p className="text-xs text-muted-foreground">{help}</p>
          <FormMessage />
        </FormItem>
      )}
    />
  );
  const flag = (
    name: 'requirePurchaseOrder' | 'requireReceiptBeforeBill',
    label: string,
    help: string,
  ) => (
    <FormField
      control={form.control}
      name={name}
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
            <FormLabel className="font-normal">{label}</FormLabel>
            <p className="text-xs text-muted-foreground">{help}</p>
          </div>
        </FormItem>
      )}
    />
  );

  return (
    <>
      <PageHeader
        title="Purchasing settings"
        description="Three-way matching tolerances and receiving rules for this company. Configuration, not code: nothing here is hard-wired."
      />
      <Form {...form}>
        <form
          className="space-y-4"
          onSubmit={form.handleSubmit(async (values) => {
            try {
              await update.mutateAsync(values);
              toast.success('Purchasing settings saved.');
            } catch (err) {
              toast.error(describeError(err));
            }
          })}
          noValidate
        >
          <Card>
            <CardHeader>
              <CardTitle>Matching tolerances</CardTitle>
              <CardDescription>
                A bill within tolerance is MATCHED; outside it is an EXCEPTION and cannot be paid
                until an approver reviews it.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              {percent(
                'priceTolerancePercent',
                'Price tolerance %',
                'Allowed unit-price variance between the purchase order and the bill.',
              )}
              {percent(
                'quantityTolerancePercent',
                'Quantity tolerance %',
                'Allowed variance between received and billed quantities.',
              )}
              {percent(
                'overReceiptTolerancePercent',
                'Over-receipt tolerance %',
                'How much more than ordered a goods receipt may record.',
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Receiving rules</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {flag(
                'requireReceiptBeforeBill',
                'Require a confirmed goods receipt before a bill can match',
                'Bills for unreceived quantities are flagged MISSING_RECEIPT.',
              )}
              {flag(
                'requirePurchaseOrder',
                'Require a purchase order on every bill',
                'Bills entered without a purchase order are flagged MISSING_PURCHASE_ORDER.',
              )}
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
