'use client';
import * as React from 'react';
import Link from 'next/link';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { P } from '@accounting/types';
import { upsertExchangeRateSchema, type UpsertExchangeRateInput } from '@accounting/validation';
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useCreateFxRevaluation,
  useDeleteExchangeRate,
  useExchangeRates,
  useFxRevaluationPreview,
  useFxRevaluations,
  useUpsertExchangeRate,
} from '@/lib/api/enterprise-hooks';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, endOfMonth, today } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';

type RateFormInput = z.input<typeof upsertExchangeRateSchema>;

export function ExchangeRatesPage() {
  const { hasPermission, activeCompany } = useSession();
  const rates = useExchangeRates();
  const remove = useDeleteExchangeRate();
  const [open, setOpen] = React.useState(false);
  const canManage = hasPermission(P['exchange-rate.manage']);
  const base = activeCompany?.baseCurrency ?? 'PHP';
  return (
    <>
      <PageHeader
        title="Exchange rates"
        description={`Organization-wide quotes: 1 unit of the from-currency = rate units of the to-currency. Documents take the latest quote on or before their date; reverse pairs are inverted automatically.`}
        actions={
          <Can permissions={[P['exchange-rate.manage']]}>
            <Button onClick={() => setOpen(true)} data-testid="new-rate">
              <Plus /> Add rate
            </Button>
          </Can>
        }
      />
      {rates.isLoading ? (
        <TableSkeleton columns={5} />
      ) : rates.data?.length === 0 ? (
        <EmptyState
          title="No exchange rates"
          description={`Add quotes against ${base} to invoice or pay in other currencies.`}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Pair</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Notes</TableHead>
                  {canManage ? <TableHead className="w-12" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rates.data?.map((r) => (
                  <TableRow key={r.id} data-testid="rate-row">
                    <TableCell className="whitespace-nowrap">{r.rateDate}</TableCell>
                    <TableCell className="font-mono">
                      {r.fromCurrency} → {r.toCurrency}
                    </TableCell>
                    <TableCell className="text-right tabular">{Number(r.rate)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.source}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.notes ?? ''}</TableCell>
                    {canManage ? (
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Delete rate"
                          onClick={async () => {
                            try {
                              await remove.mutateAsync(r.id);
                            } catch (err) {
                              toast.error(describeError(err));
                            }
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <RateDialog open={open} onOpenChange={setOpen} base={base} />
    </>
  );
}

function RateDialog({
  open,
  onOpenChange,
  base,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  base: string;
}) {
  const upsert = useUpsertExchangeRate();
  const form = useForm<RateFormInput, unknown, UpsertExchangeRateInput>({
    resolver: zodResolver(upsertExchangeRateSchema),
    defaultValues: {
      fromCurrency: 'USD',
      toCurrency: base,
      rateDate: today(),
      rate: '',
      source: 'MANUAL',
    },
  });
  React.useEffect(() => {
    if (open)
      form.reset({
        fromCurrency: 'USD',
        toCurrency: base,
        rateDate: today(),
        rate: '',
        source: 'MANUAL',
      });
  }, [open, base, form]);
  const submit = form.handleSubmit(async (values) => {
    try {
      const saved = await upsert.mutateAsync(values);
      toast.success(
        `${saved.fromCurrency}/${saved.toCurrency} on ${saved.rateDate} = ${Number(saved.rate)}.`,
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  });
  const code = (name: 'fromCurrency' | 'toCurrency', label: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              className="font-mono uppercase"
              maxLength={3}
              onChange={(e) => field.onChange(e.target.value.toUpperCase())}
              data-testid={`rate-${name}`}
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
          <DialogTitle>Add exchange rate</DialogTitle>
          <DialogDescription>
            Saving the same pair and date again replaces the quote.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <div className="grid gap-3 sm:grid-cols-3">
              {code('fromCurrency', 'From')}
              {code('toCurrency', 'To')}
              <FormField
                control={form.control}
                name="rate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rate</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="decimal"
                        className="tabular"
                        {...field}
                        placeholder="56.25"
                        data-testid="rate-value"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="rateDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Effective date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
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
              <Button type="submit" disabled={upsert.isPending} data-testid="rate-save">
                Save
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------- revaluation

export function FxRevaluationsPage() {
  const { hasPermission } = useSession();
  const [page, setPage] = React.useState(1);
  const runs = useFxRevaluations(page);
  const [asOf, setAsOf] = React.useState(endOfMonth());
  const [notes, setNotes] = React.useState('');
  const preview = useFxRevaluationPreview(asOf || null);
  const create = useCreateFxRevaluation();
  const canRun = hasPermission(P['fx.revalue']);
  const lines = preview.data?.lines ?? [];
  // Receivables and bank balances gain when worth more base; payables and lease liabilities lose.
  const isAsset = (side: string) => side === 'AR' || side === 'BANK';
  const gain = lines.reduce(
    (s, l) =>
      s +
      (isAsset(l.side) ? Math.max(Number(l.adjustment), 0) : Math.max(-Number(l.adjustment), 0)),
    0,
  );
  const loss = lines.reduce(
    (s, l) =>
      s +
      (isAsset(l.side) ? Math.max(-Number(l.adjustment), 0) : Math.max(Number(l.adjustment), 0)),
    0,
  );
  return (
    <>
      <PageHeader
        title="FX revaluation"
        description="Restates every open foreign-currency receivable and payable at the closing rate: an adjusting entry on the as-of date and its automatic reversal the next day, so the controls stay at document rates."
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle>Preview at closing rates</CardTitle>
            <CardDescription>
              Open items whose value moves at the rates in force on the as-of date.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label>As of</Label>
                <Input
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                  data-testid="reval-date"
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label>Notes</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </div>
              {canRun ? (
                <Button
                  disabled={lines.length === 0 || create.isPending}
                  data-testid="reval-run"
                  onClick={async () => {
                    try {
                      const run = await create.mutateAsync({
                        asOfDate: asOf,
                        notes: notes.trim() || undefined,
                      });
                      toast.success(
                        `${run.runNumber} posted (${run.journalNumber}) and reversed on ${run.reversalDate}.`,
                      );
                      setNotes('');
                    } catch (err) {
                      toast.error(describeError(err));
                    }
                  }}
                >
                  Post revaluation
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Open items moving" value={lines.length} />
              <Stat
                label="Unrealized gain"
                value={<Amount value={gain.toFixed(4)} className="text-left" zeroAsDash />}
              />
              <Stat
                label="Unrealized loss"
                value={<Amount value={loss.toFixed(4)} className="text-left" zeroAsDash />}
                danger={loss > 0}
              />
            </div>
            {preview.isError ? (
              <p className="text-sm text-critical">{describeError(preview.error)}</p>
            ) : preview.isLoading ? (
              <Skeleton className="h-24" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Side</TableHead>
                    <TableHead>Document</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                    <TableHead className="text-right">Doc rate</TableHead>
                    <TableHead className="text-right">Closing</TableHead>
                    <TableHead className="text-right">Adjustment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                        Nothing to revalue on this date.
                      </TableCell>
                    </TableRow>
                  ) : (
                    lines.map((l) => (
                      <TableRow key={`${l.side}-${l.documentId}`} data-testid="reval-line">
                        <TableCell>{l.side}</TableCell>
                        <TableCell className="font-mono text-xs">{l.documentNumber}</TableCell>
                        <TableCell className="text-right tabular">
                          {l.openAmount} {l.currency}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {Number(l.documentRate)}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {Number(l.closingRate)}
                        </TableCell>
                        <TableCell>
                          <Amount value={l.adjustment} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Run</TableHead>
                  <TableHead className="text-right">Gain / loss</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs.data?.items ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="py-6 text-center text-muted-foreground">
                      No revaluations yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  runs.data!.items.map((r) => (
                    <TableRow key={r.id} data-testid="reval-run-row">
                      <TableCell>
                        <div className="font-mono text-xs">{r.runNumber}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.asOfDate} → reversed {r.reversalDate} ·{' '}
                          {r.journalEntryId ? (
                            <Link
                              href={`/accounting/journal-entries/${r.journalEntryId}`}
                              className="hover:underline"
                            >
                              {r.journalNumber}
                            </Link>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatDateTime(r.createdAt)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular">
                        <div>+{r.unrealizedGain}</div>
                        <div className="text-critical">−{r.unrealizedLoss}</div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              {(runs.data?.totalPages ?? 1) > 1 ? (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2} className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => setPage(page - 1)}
                      >
                        Prev
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={page >= (runs.data?.totalPages ?? 1)}
                        onClick={() => setPage(page + 1)}
                      >
                        Next
                      </Button>
                    </TableCell>
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
