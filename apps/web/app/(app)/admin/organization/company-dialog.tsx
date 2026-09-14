'use client';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import { createCompanySchema, type CreateCompanyInput } from '@accounting/validation';
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
import { describeError } from '@/lib/api/client';
import { useCreateCompany, useUpdateCompany } from '@/lib/api/hooks';
import type { Company } from '@/lib/api/types';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

type FormValues = z.input<typeof createCompanySchema>;

const toFormValues = (c?: Company): FormValues => ({
  code: c?.code ?? '',
  name: c?.name ?? '',
  legalName: c?.legalName ?? undefined,
  taxIdentificationNumber: c?.taxIdentificationNumber ?? undefined,
  baseCurrency: c?.baseCurrency ?? 'PHP',
  fiscalYearStartMonth: c?.fiscalYearStartMonth ?? 1,
  addressLine1: c?.addressLine1 ?? undefined,
  addressLine2: c?.addressLine2 ?? undefined,
  city: c?.city ?? undefined,
  province: c?.province ?? undefined,
  postalCode: c?.postalCode ?? undefined,
  country: c?.country ?? 'PH',
});

export function CompanyDialog({
  open,
  company,
  onOpenChange,
}: {
  open: boolean;
  company?: Company;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateCompany();
  const update = useUpdateCompany();
  const form = useForm<FormValues, unknown, CreateCompanyInput>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: toFormValues(company),
  });

  React.useEffect(() => {
    if (open) form.reset(toFormValues(company));
  }, [open, company, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (company) {
        await update.mutateAsync({ id: company.id, ...values });
        toast.success('Company updated.');
      } else {
        await create.mutateAsync(values);
        toast.success('Company created.');
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  const text = (
    name: keyof FormValues,
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
              value={(field.value as string | number | undefined) ?? ''}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{company ? `Edit ${company.code}` : 'New company'}</DialogTitle>
          <DialogDescription>
            A company is a legal entity with its own books. The functional currency cannot be
            changed once transactions exist.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-2" noValidate>
            {text('code', 'Code', {
              placeholder: 'ACME',
              disabled: Boolean(company),
              className: 'uppercase',
            })}
            {text('name', 'Name', { placeholder: 'Acme Trading Corporation' })}
            {text('legalName', 'Legal name')}
            {text('taxIdentificationNumber', 'Tax identification number (TIN)', {
              placeholder: '000-000-000-000',
            })}
            {text('baseCurrency', 'Functional currency', {
              maxLength: 3,
              className: 'uppercase',
              disabled: Boolean(company),
            })}
            <FormField
              control={form.control}
              name="fiscalYearStartMonth"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fiscal year starts</FormLabel>
                  <Select
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {MONTHS.map((m, i) => (
                        <SelectItem key={m} value={String(i + 1)}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {text('addressLine1', 'Address line 1')}
            {text('addressLine2', 'Address line 2')}
            {text('city', 'City')}
            {text('province', 'Province')}
            {text('postalCode', 'Postal code')}
            {text('country', 'Country (ISO)', { maxLength: 2, className: 'uppercase' })}
            <DialogFooter className="md:col-span-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                {company ? 'Save changes' : 'Create company'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
