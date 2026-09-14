'use client';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  NORMAL_BALANCE_BY_TYPE,
} from '@accounting/types';
import { createAccountSchema, type CreateAccountInput } from '@accounting/validation';
import {
  Button,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useCreateAccount, useUpdateAccount } from '@/lib/api/accounting-hooks';
import type { AccountNode } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { AccountCombobox } from '@/components/accounting/primitives';

type FormInput = z.input<typeof createAccountSchema>;
const NONE = '__none__';

export function AccountDialog({
  open,
  account,
  parent,
  onOpenChange,
}: {
  open: boolean;
  account?: AccountNode;
  parent?: AccountNode;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const editing = Boolean(account);

  const defaults = React.useCallback(
    (): FormInput => ({
      code: account?.code ?? '',
      name: account?.name ?? '',
      type: account?.type ?? parent?.type ?? 'ASSET',
      subtype: account?.subtype ?? null,
      normalBalance: account?.normalBalance ?? undefined,
      parentId: account?.parentId ?? parent?.id ?? null,
      currency: account?.currency ?? null,
      isHeader: account?.isHeader ?? false,
      description: account?.description ?? undefined,
    }),
    [account, parent],
  );

  const form = useForm<FormInput, unknown, CreateAccountInput>({
    resolver: zodResolver(createAccountSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);

  const type = form.watch('type');

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (account) {
        await update.mutateAsync({
          id: account.id,
          name: values.name,
          subtype: values.subtype ?? null,
          parentId: values.parentId ?? null,
          description: values.description,
        });
        toast.success(`Account ${account.code} updated.`);
      } else {
        const created = await create.mutateAsync(values);
        toast.success(`Account ${created.code} ${created.name} created.`);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? `Edit ${account!.code}`
              : parent
                ? `New account under ${parent.code} ${parent.name}`
                : 'New account'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Code, type and normal balance are fixed once an account exists.'
              : 'Choose a parent to build the hierarchy; the parent becomes a header account.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="grid gap-3 md:grid-cols-2" noValidate>
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="1130"
                      className="font-mono"
                      disabled={editing}
                      autoFocus={!editing}
                      {...field}
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
                    <Input placeholder="Cash in Bank" autoFocus={editing} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={editing || Boolean(parent)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ACCOUNT_TYPES.map((t) => (
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
              name="normalBalance"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Normal balance</FormLabel>
                  <Select
                    value={field.value ?? NORMAL_BALANCE_BY_TYPE[type ?? 'ASSET']}
                    onValueChange={field.onChange}
                    disabled={editing}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {NORMAL_BALANCES.map((n) => (
                        <SelectItem key={n} value={n}>
                          {titleCase(n)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Contra accounts (e.g. accumulated depreciation) use the opposite side.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="parentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Parent account</FormLabel>
                  <AccountCombobox
                    value={field.value ?? null}
                    onChange={(id) => field.onChange(id)}
                    postableOnly={false}
                    placeholder="None (top level)"
                    excludeIds={account ? [account.id] : []}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="subtype"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Subtype</FormLabel>
                  <Select
                    value={field.value ?? NONE}
                    onValueChange={(v) => field.onChange(v === NONE ? null : v)}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {ACCOUNT_SUBTYPES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {titleCase(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Used by dashboards and future control-account checks.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!editing ? (
              <FormField
                control={form.control}
                name="isHeader"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0 md:col-span-2">
                    <FormControl>
                      <Checkbox
                        checked={field.value ?? false}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    </FormControl>
                    <FormLabel className="font-normal">
                      Header account (groups children, not postable)
                    </FormLabel>
                  </FormItem>
                )}
              />
            ) : null}
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="md:col-span-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                {editing ? 'Save changes' : 'Create account'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
