'use client';
import * as React from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Landmark, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { P } from '@accounting/types';
import {
  bankingSettingsSchema,
  createBankAccountSchema,
  type BankingSettingsInput,
  type CreateBankAccountInput,
} from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Skeleton,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useBankAccounts,
  useBankingSettings,
  useCreateBankAccount,
  useUpdateBankAccount,
  useUpdateBankingSettings,
} from '@/lib/api/assets-banking-hooks';
import type { BankAccount } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { AccountCombobox, Amount } from '@/components/accounting/primitives';
import { RECONCILIATION_PATH, TRANSACTIONS_PATH } from './shared';

type AccountFormInput = z.input<typeof createBankAccountSchema>;

export function BankAccountsPage() {
  const { hasPermission } = useSession();
  const accounts = useBankAccounts();
  const update = useUpdateBankAccount();
  const [dialog, setDialog] = React.useState<{ open: boolean; account?: BankAccount }>({
    open: false,
  });
  const canManage = hasPermission(P['bank-account.manage']);

  return (
    <>
      <PageHeader
        title="Bank accounts"
        description="Each bank or cash account books to one GL account. The balance shown is the ledger balance; the bank's view arrives through statements."
        actions={
          <Can permissions={[P['bank-account.manage']]}>
            <Button onClick={() => setDialog({ open: true })}>
              <Plus /> New bank account
            </Button>
          </Can>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          {accounts.isLoading ? (
            <Skeleton className="h-48" />
          ) : accounts.data?.length === 0 ? (
            <EmptyState title="No bank accounts" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {accounts.data?.map((a) => (
                <Card key={a.id} data-testid="bank-account-card">
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center justify-between text-base">
                      <span className="flex items-center gap-2">
                        <Landmark className="h-4 w-4 text-muted-foreground" />
                        <span className="font-mono text-xs text-muted-foreground">{a.code}</span>
                        {a.name}
                      </span>
                      <Badge variant={a.status === 'ACTIVE' ? 'success' : 'secondary'}>
                        {a.status}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      {[a.bankName, a.accountNumber].filter(Boolean).join(' · ') || 'Cash'} · GL{' '}
                      <span className="font-mono">{a.glAccountCode}</span> {a.glAccountName}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-muted-foreground">Ledger balance</span>
                      <Amount
                        value={a.ledgerBalance}
                        currency={a.currency}
                        className="text-lg font-semibold"
                      />
                    </div>
                    <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                      <span>Last statement {a.lastStatementDate ?? '-'}</span>
                      <span>
                        {a.unreconciledCount > 0
                          ? `${a.unreconciledCount} statement${a.unreconciledCount === 1 ? '' : 's'} open`
                          : 'Nothing open'}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`${TRANSACTIONS_PATH}?bankAccountId=${a.id}`}>
                          Transactions
                        </Link>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`${RECONCILIATION_PATH}?bankAccountId=${a.id}`}>
                          Statements
                        </Link>
                      </Button>
                      {canManage ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDialog({ open: true, account: a })}
                          >
                            <Pencil /> Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                              try {
                                await update.mutateAsync({
                                  id: a.id,
                                  status: a.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                                });
                              } catch (err) {
                                toast.error(describeError(err));
                              }
                            }}
                          >
                            {a.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
        <BankingSettingsCard />
      </div>
      <BankAccountDialog
        open={dialog.open}
        account={dialog.account}
        onOpenChange={(open) => setDialog({ open })}
      />
    </>
  );
}

function BankingSettingsCard() {
  const { hasPermission } = useSession();
  const settings = useBankingSettings();
  const update = useUpdateBankingSettings();
  const form = useForm<z.input<typeof bankingSettingsSchema>, unknown, BankingSettingsInput>({
    resolver: zodResolver(bankingSettingsSchema),
    defaultValues: { matchDateToleranceDays: 3, autoMatchMinConfidence: 'MEDIUM' },
  });
  React.useEffect(() => {
    if (settings.data)
      form.reset({
        matchDateToleranceDays: settings.data.matchDateToleranceDays,
        autoMatchMinConfidence: settings.data.autoMatchMinConfidence,
      });
  }, [settings.data, form]);
  const canManage = hasPermission(P['bank-account.manage']);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Matching</CardTitle>
        <CardDescription>
          A statement line matches a ledger line with the same signed amount within this many days.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="space-y-3"
            onSubmit={form.handleSubmit(async (values) => {
              try {
                await update.mutateAsync(values);
                toast.success('Settings saved.');
              } catch (err) {
                toast.error(describeError(err));
              }
            })}
          >
            <FormField
              control={form.control}
              name="matchDateToleranceDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date tolerance (days)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={60}
                      {...field}
                      value={String(field.value ?? '')}
                      disabled={!canManage}
                    />
                  </FormControl>
                  <FormDescription>Also applies when re-running the matcher.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="autoMatchMinConfidence"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Auto-match confidence</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={!canManage}>
                    <FormControl>
                      <SelectTrigger data-testid="match-confidence">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="MEDIUM">
                        Medium - a unique amount / date hit is matched
                      </SelectItem>
                      <SelectItem value="HIGH">
                        High - a reference must also agree; otherwise suggest only
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Below the bar a line becomes &quot;possible match&quot; with the suggested
                    ledger line for a person to confirm - nothing uncertain is reconciled
                    automatically.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {canManage ? (
              <Button type="submit" size="sm" disabled={update.isPending}>
                Save
              </Button>
            ) : null}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function BankAccountDialog({
  open,
  account,
  onOpenChange,
}: {
  open: boolean;
  account?: BankAccount;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateBankAccount();
  const update = useUpdateBankAccount();
  const defaults = React.useCallback(
    (): AccountFormInput => ({
      code: account?.code ?? '',
      name: account?.name ?? '',
      bankName: account?.bankName ?? undefined,
      accountNumber: account?.accountNumber ?? undefined,
      glAccountId: account?.glAccountId ?? '',
      notes: account?.notes ?? undefined,
    }),
    [account],
  );
  const form = useForm<AccountFormInput, unknown, CreateBankAccountInput>({
    resolver: zodResolver(createBankAccountSchema),
    defaultValues: defaults(),
  });
  React.useEffect(() => {
    if (open) form.reset(defaults());
  }, [open, defaults, form]);
  const submit = form.handleSubmit(async (values) => {
    try {
      if (account) {
        const { glAccountId: _gl, ...rest } = values;
        await update.mutateAsync({ id: account.id, ...rest });
      } else await create.mutateAsync(values);
      toast.success(account ? 'Bank account updated.' : 'Bank account created.');
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  const text = (
    name: 'code' | 'name' | 'bankName' | 'accountNumber',
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
              value={field.value ?? ''}
              onChange={(e) =>
                field.onChange(name === 'code' ? e.target.value.toUpperCase() : e.target.value)
              }
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{account ? `Edit ${account.code}` : 'New bank account'}</DialogTitle>
          <DialogDescription>
            The GL account must be a postable cash or bank asset account and is fixed once set.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-[130px_1fr]">
              {text('code', 'Code', {
                className: 'font-mono uppercase',
                disabled: Boolean(account),
                placeholder: 'BDO-MAIN',
              })}
              {text('name', 'Name')}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {text('bankName', 'Bank')}
              {text('accountNumber', 'Account number')}
            </div>
            <FormField
              control={form.control}
              name="glAccountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>GL account</FormLabel>
                  <AccountCombobox
                    value={field.value || null}
                    onChange={(id) => field.onChange(id)}
                    types={['ASSET']}
                    subtypes={['CASH', 'BANK']}
                    disabled={Boolean(account)}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {account ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
