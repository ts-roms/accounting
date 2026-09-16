'use client';
import * as React from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarCheck, Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { P } from '@accounting/types';
import { prepaymentSchema, type PrepaymentInput } from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreatePrepayment,
  usePrepayment,
  usePrepaymentAction,
  usePrepayments,
  useRecognizePrepayments,
} from '@/lib/api/accounting-core-hooks';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { ConfirmDialog, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';

type FormInput = z.input<typeof prepaymentSchema>;

const STATUS_VARIANT = {
  DRAFT: 'secondary',
  ACTIVE: 'success',
  COMPLETED: 'outline',
  CANCELLED: 'destructive',
} as const;

/** Prepaid expenses: initial posting and straight-line recognition schedule. */
export function PrepaymentsPage() {
  const { hasPermission, activeCompany } = useSession();
  const currency = activeCompany?.baseCurrency ?? 'PHP';
  const list = usePrepayments({ pageSize: 100 });
  const action = usePrepaymentAction();
  const recognize = useRecognizePrepayments();
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [cancelling, setCancelling] = React.useState<string | null>(null);
  const [asOf, setAsOf] = React.useState(today());
  const canManage = hasPermission(P['prepayment.manage']);
  const canPost = hasPermission(P['prepayment.post']);

  const recognizeDue = async (prepaymentId?: string) => {
    try {
      const r = await recognize.mutateAsync({ asOf, prepaymentId });
      toast.success(`${r.recognized.length} instalment(s) recognised.`);
      for (const s of r.skipped) toast.warning(s.reason);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Prepayments"
        description="Dr prepaid / Cr cash or payable on activation, then Dr expense / Cr prepaid per month. Every instalment is a posted adjusting journal; the remaining amount always equals the prepaid balance."
        actions={
          <div className="flex items-end gap-2">
            {canPost ? (
              <>
                <Input
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                  className="w-40"
                  aria-label="Recognise as of"
                />
                <Button
                  variant="outline"
                  onClick={() => void recognizeDue()}
                  loading={recognize.isPending}
                  data-testid="prepayment-recognize-all"
                >
                  <CalendarCheck /> Recognise due
                </Button>
              </>
            ) : null}
            {canManage ? (
              <Button onClick={() => setCreating(true)} data-testid="prepayment-new">
                <Plus /> New prepayment
              </Button>
            ) : null}
          </div>
        }
      />
      <Card>
        <CardContent className="p-0">
          {list.isLoading ? (
            <TableSkeleton columns={7} rows={5} />
          ) : !list.data?.items.length ? (
            <EmptyState
              title="No prepayments"
              description="Create one to spread a prepaid expense over its service period."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Accounts</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-52" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((p) => (
                  <TableRow key={p.id} data-testid={`prepayment-${p.name}`}>
                    <TableCell>
                      <button
                        className="text-left font-medium hover:underline"
                        onClick={() => setSelected(p.id)}
                      >
                        {p.name}
                      </button>
                      <div className="text-xs text-muted-foreground">
                        {p.reference ?? p.description ?? ''}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.prepaidAccountCode} → {p.expenseAccountCode}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.months} months from {p.startDate}
                    </TableCell>
                    <TableCell>
                      <Amount value={p.amount} currency={p.currency} />
                    </TableCell>
                    <TableCell>
                      <Amount value={p.remainingAmount} currency={p.currency} />
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[p.status]}>{titleCase(p.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {p.status === 'DRAFT' && canPost ? (
                          <Button
                            size="sm"
                            onClick={async () => {
                              try {
                                await action.mutateAsync({ id: p.id, action: 'activate' });
                                toast.success('Prepayment activated.');
                              } catch (err) {
                                toast.error(describeError(err));
                              }
                            }}
                            data-testid="prepayment-activate"
                          >
                            Activate
                          </Button>
                        ) : null}
                        {p.status === 'ACTIVE' && canPost ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void recognizeDue(p.id)}
                          >
                            Recognise
                          </Button>
                        ) : null}
                        {(p.status === 'DRAFT' || p.status === 'ACTIVE') && canManage ? (
                          <Button size="sm" variant="ghost" onClick={() => setCancelling(p.id)}>
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <PrepaymentDialog open={creating} onClose={() => setCreating(false)} currency={currency} />
      <ScheduleDialog id={selected} onClose={() => setSelected(null)} />
      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(o) => !o && setCancelling(null)}
        title="Cancel prepayment"
        description="Pending instalments are cancelled. If nothing was recognised yet the initial entry is reversed; otherwise the remaining prepaid balance must be cleared with a manual journal."
        confirmLabel="Cancel prepayment"
        destructive
        onConfirm={async () => {
          try {
            await action.mutateAsync({
              id: cancelling!,
              action: 'cancel',
              reason: 'Cancelled from the prepayments screen',
            });
            toast.success('Prepayment cancelled.');
          } catch (err) {
            toast.error(describeError(err));
          } finally {
            setCancelling(null);
          }
        }}
      />
    </>
  );
}

function PrepaymentDialog({
  open,
  onClose,
  currency,
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
}) {
  const create = useCreatePrepayment();
  const form = useForm<FormInput, unknown, PrepaymentInput>({
    resolver: zodResolver(prepaymentSchema),
    defaultValues: {
      name: '',
      description: '',
      reference: '',
      prepaidAccountId: '',
      expenseAccountId: '',
      creditAccountId: null,
      amount: '',
      startDate: today(),
      months: 12,
    },
  });
  const submit = form.handleSubmit(async (values) => {
    try {
      await create.mutateAsync(values);
      toast.success('Prepayment created as a draft.');
      form.reset();
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New prepayment</DialogTitle>
          <DialogDescription>
            Amount in {currency}, spread straight-line over the months from the start date.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="grid gap-3 md:grid-cols-2" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input data-testid="prepayment-name" {...field} />
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
                  <FormLabel>Reference</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="prepaidAccountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Prepaid account</FormLabel>
                  <AccountCombobox
                    value={field.value}
                    onChange={(id) => field.onChange(id)}
                    types={['ASSET']}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="expenseAccountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Expense account</FormLabel>
                  <AccountCombobox
                    value={field.value}
                    onChange={(id) => field.onChange(id)}
                    types={['EXPENSE', 'COST_OF_SALES', 'OTHER_EXPENSE']}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="creditAccountId"
              render={({ field }) => (
                <FormItem className="md:col-span-2">
                  <FormLabel>
                    Paid from (cash / bank / payable) - leave empty if already posted by a bill
                  </FormLabel>
                  <AccountCombobox
                    value={field.value}
                    onChange={(id) => field.onChange(id)}
                    placeholder="No initial posting"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" data-testid="prepayment-amount" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="months"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Months</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={120}
                      {...field}
                      value={String(field.value ?? 12)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Start date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="md:col-span-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending} data-testid="prepayment-save">
                Create
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = usePrepayment(id);
  const p = detail.data;
  return (
    <Dialog open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{p?.name ?? 'Prepayment'}</DialogTitle>
          <DialogDescription>
            {p?.initialDocumentNumber ? (
              <>
                Initial entry{' '}
                <Link
                  href={`/accounting/journal-entries/${p.initialEntryId}`}
                  className="font-mono hover:underline"
                >
                  {p.initialDocumentNumber}
                </Link>
              </>
            ) : (
              'No initial entry (posted elsewhere).'
            )}
          </DialogDescription>
        </DialogHeader>
        {!p ? (
          <TableSkeleton columns={4} rows={6} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>#</TableHead>
                <TableHead>Recognise on</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Journal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.schedules.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{s.sequence}</TableCell>
                  <TableCell>{s.recognitionDate}</TableCell>
                  <TableCell>
                    <Amount value={s.amount} currency={p.currency} />
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === 'RECOGNIZED'
                          ? 'success'
                          : s.status === 'CANCELLED'
                            ? 'destructive'
                            : 'secondary'
                      }
                    >
                      {titleCase(s.status)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {s.journalEntryId ? (
                      <Link
                        href={`/accounting/journal-entries/${s.journalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {s.documentNumber}
                      </Link>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}
