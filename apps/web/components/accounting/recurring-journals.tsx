'use client';
import * as React from 'react';
import Link from 'next/link';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pause, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Money } from '@accounting/money';
import {
  JOURNAL_TYPES,
  P,
  RECURRING_FREQUENCIES,
  RECURRING_JOURNAL_MODES,
} from '@accounting/types';
import { recurringJournalSchema, type RecurringJournalInput } from '@accounting/validation';
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
import {
  useCreateRecurringJournal,
  useRecurringJournal,
  useRecurringJournals,
  useRunRecurringJournals,
  useUpdateRecurringJournal,
} from '@/lib/api/accounting-core-hooks';
import type { RecurringJournal } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import {
  AccountCombobox,
  Amount,
  JournalStatusBadge,
  today,
} from '@/components/accounting/primitives';

type FormInput = z.input<typeof recurringJournalSchema>;

const emptyLine = () => ({ accountId: '', debit: '0', credit: '0', description: '' });

const STATUS_VARIANT = { ACTIVE: 'success', PAUSED: 'warning', COMPLETED: 'secondary' } as const;

/** Recurring journal templates: schedule, mode, lines and the occurrences they generated. */
export function RecurringJournalsPage() {
  const { hasPermission, activeCompany } = useSession();
  const currency = activeCompany?.baseCurrency ?? 'PHP';
  const list = useRecurringJournals({ pageSize: 100 });
  const update = useUpdateRecurringJournal();
  const run = useRunRecurringJournals();
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [asOf, setAsOf] = React.useState(today());
  const canManage = hasPermission(P['recurring-journal.manage']);

  const runNow = async (id?: string) => {
    try {
      const result = await run.mutateAsync({ asOf, recurringJournalId: id });
      toast.success(
        `${result.generated.length} occurrence(s) generated${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.`,
      );
      for (const s of result.skipped) toast.warning(`${s.name || 'Template'}: ${s.reason}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  const toggle = async (t: RecurringJournal) => {
    try {
      await update.mutateAsync({ id: t.id, status: t.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' });
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Recurring journals"
        description="Templates for rent, subscriptions and standing accruals. DRAFT occurrences go through submit / approve / post; AUTO_POST templates post on their own and need a journal.post holder to switch on."
        actions={
          canManage ? (
            <div className="flex items-end gap-2">
              <Input
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="w-40"
                aria-label="Run as of"
              />
              <Button
                variant="outline"
                onClick={() => void runNow()}
                loading={run.isPending}
                data-testid="recurring-run-all"
              >
                <Repeat /> Run due
              </Button>
              <Button onClick={() => setCreating(true)} data-testid="recurring-new">
                <Plus /> New template
              </Button>
            </div>
          ) : null
        }
      />
      <Card>
        <CardContent className="p-0">
          {list.isLoading ? (
            <TableSkeleton columns={7} rows={5} />
          ) : !list.data?.items.length ? (
            <EmptyState
              title="No recurring journals"
              description="Create a template to generate journals on a schedule."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-48" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((t) => (
                  <TableRow key={t.id} data-testid={`recurring-${t.name}`}>
                    <TableCell>
                      <button
                        className="text-left font-medium hover:underline"
                        onClick={() => setSelected(t.id)}
                      >
                        {t.name}
                      </button>
                      <div className="text-xs text-muted-foreground">{t.description}</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {t.interval > 1 ? `Every ${t.interval} × ` : ''}
                      {titleCase(t.frequency)}
                      <div className="text-xs text-muted-foreground">
                        from {t.startDate}
                        {t.endDate ? ` to ${t.endDate}` : ''}
                        {t.maxOccurrences ? ` · max ${t.maxOccurrences}` : ''}
                        {t.autoReverse ? ' · auto-reverse' : ''}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.mode === 'AUTO_POST' ? 'warning' : 'secondary'}>
                        {titleCase(t.mode)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {t.nextRunDate ?? '-'}
                      <div className="text-xs text-muted-foreground">{t.occurrences} generated</div>
                    </TableCell>
                    <TableCell>
                      <Amount
                        value={t.lines
                          .reduce(
                            (acc, l) => acc.add(Money.of(l.debit, currency)),
                            Money.zero(currency),
                          )
                          .toString()}
                        currency={currency}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[t.status]}>{titleCase(t.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && t.status !== 'COMPLETED' ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void toggle(t)}
                            title={t.status === 'PAUSED' ? 'Resume' : 'Pause'}
                          >
                            {t.status === 'PAUSED' ? <Play /> : <Pause />}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void runNow(t.id)}
                            disabled={t.status !== 'ACTIVE'}
                          >
                            Run
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <RecurringJournalDialog
        open={creating}
        onClose={() => setCreating(false)}
        currency={currency}
        canAutoPost={hasPermission(P['journal.post'])}
      />
      <RunsDialog id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function RecurringJournalDialog({
  open,
  onClose,
  currency,
  canAutoPost,
}: {
  open: boolean;
  onClose: () => void;
  currency: string;
  canAutoPost: boolean;
}) {
  const create = useCreateRecurringJournal();
  const form = useForm<FormInput, unknown, RecurringJournalInput>({
    resolver: zodResolver(recurringJournalSchema),
    defaultValues: {
      name: '',
      description: '',
      reference: '',
      journalType: 'GENERAL',
      frequency: 'MONTHLY',
      interval: 1,
      startDate: today(),
      endDate: null,
      maxOccurrences: null,
      mode: 'DRAFT',
      autoReverse: false,
      lines: [emptyLine(), emptyLine()],
    },
  });
  const lines = useFieldArray({ control: form.control, name: 'lines' });
  const watched = useWatch({ control: form.control, name: 'lines' });
  const sum = (side: 'debit' | 'credit') =>
    (watched ?? []).reduce((acc, l) => {
      const v = l?.[side] ?? '0';
      return Money.isValidDecimalString(v) ? acc.add(Money.of(v, currency)) : acc;
    }, Money.zero(currency));
  const balanced = sum('debit').equals(sum('credit')) && !sum('debit').isZero();

  const submit = form.handleSubmit(async (values) => {
    try {
      await create.mutateAsync(values);
      toast.success('Template created.');
      form.reset();
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New recurring journal</DialogTitle>
          <DialogDescription>
            Lines are in {currency}. Every occurrence is a separate journal with its own audit
            trail.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 md:grid-cols-3">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input data-testid="recurring-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="frequency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Frequency</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {RECURRING_FREQUENCIES.map((f) => (
                          <SelectItem key={f} value={f}>
                            {titleCase(f)}
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
                name="interval"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Every N</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} {...field} value={String(field.value ?? 1)} />
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
                        {JOURNAL_TYPES.filter(
                          (t) => !['REVERSAL', 'CLOSING', 'OPENING'].includes(t),
                        ).map((t) => (
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
                name="startDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End (optional)</FormLabel>
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
                name="maxOccurrences"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Max occurrences</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        {...field}
                        value={field.value == null ? '' : String(field.value)}
                        onChange={(e) =>
                          field.onChange(e.target.value ? Number(e.target.value) : null)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mode</FormLabel>
                    <Select value={field.value ?? 'DRAFT'} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="recurring-mode">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {RECURRING_JOURNAL_MODES.map((m) => (
                          <SelectItem
                            key={m}
                            value={m}
                            disabled={m === 'AUTO_POST' && !canAutoPost}
                          >
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
                name="autoReverse"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 pt-6">
                    <FormControl>
                      <input
                        type="checkbox"
                        checked={Boolean(field.value)}
                        onChange={(e) => field.onChange(e.target.checked)}
                      />
                    </FormControl>
                    <FormLabel className="!mt-0">Auto-reverse next month</FormLabel>
                  </FormItem>
                )}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-[260px]">Account</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-32 text-right">Debit</TableHead>
                  <TableHead className="w-32 text-right">Credit</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.fields.map((f, i) => (
                  <TableRow key={f.id} className="hover:bg-transparent">
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${i}.accountId`}
                        render={({ field }) => (
                          <FormItem>
                            <AccountCombobox
                              value={field.value}
                              onChange={(id) => field.onChange(id)}
                            />
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${i}.description`}
                        render={({ field }) => <Input {...field} value={field.value ?? ''} />}
                      />
                    </TableCell>
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${i}.debit`}
                        render={({ field }) => (
                          <Input
                            inputMode="decimal"
                            className="text-right"
                            {...field}
                            value={field.value ?? '0'}
                          />
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <FormField
                        control={form.control}
                        name={`lines.${i}.credit`}
                        render={({ field }) => (
                          <Input
                            inputMode="decimal"
                            className="text-right"
                            {...field}
                            value={field.value ?? '0'}
                          />
                        )}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => lines.remove(i)}
                        disabled={lines.fields.length <= 2}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between text-sm">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => lines.append(emptyLine())}
              >
                <Plus /> Add line
              </Button>
              <span className={balanced ? 'text-success' : 'text-destructive'}>
                Debits{' '}
                <Amount value={sum('debit').toString()} currency={currency} className="inline" /> ·
                Credits{' '}
                <Amount value={sum('credit').toString()} currency={currency} className="inline" /> ·{' '}
                {balanced ? 'Balanced' : 'Out of balance'}
              </span>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={create.isPending}
                disabled={!balanced}
                data-testid="recurring-save"
              >
                Create template
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RunsDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useRecurringJournal(id);
  const t = detail.data;
  return (
    <Dialog open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t?.name ?? 'Template'}</DialogTitle>
          <DialogDescription>
            Occurrences generated from this template, newest first.
          </DialogDescription>
        </DialogHeader>
        {!t ? (
          <TableSkeleton columns={3} rows={4} />
        ) : t.runs.length === 0 ? (
          <EmptyState
            title="Nothing generated yet"
            description={`Next run: ${t.nextRunDate ?? 'none'}`}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Run date</TableHead>
                <TableHead>Journal</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {t.runs.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.runDate}</TableCell>
                  <TableCell>
                    {r.journalEntryId ? (
                      <Link
                        href={`/accounting/journal-entries/${r.journalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {r.documentNumber}
                      </Link>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    {r.journalStatus ? <JournalStatusBadge status={r.journalStatus} /> : '-'}
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
