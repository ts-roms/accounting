'use client';
import * as React from 'react';
import { CalendarClock, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Money, formatMoney } from '@accounting/money';
import type { ForecastGranularity, ForecastScenario } from '@accounting/types';
import {
  FORECAST_GRANULARITIES,
  FORECAST_ITEM_FREQUENCIES,
  FORECAST_SCENARIOS,
  P,
} from '@accounting/types';
import {
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
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useBankAccounts } from '@/lib/api/assets-banking-hooks';
import {
  useCashForecast,
  useCreateForecastItem,
  useDeleteForecastItem,
  useForecastItems,
  useForecastSnapshots,
  useUpdateForecastItem,
} from '@/lib/api/treasury-hooks';
import type { CashForecastItem } from '@/lib/api/treasury-types';
import { titleCase } from '@/lib/format';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { Field, Kpi, LineChart, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from './shared';

const SOURCE_LABEL: Record<string, string> = {
  AR_INVOICES: 'Customer invoices (probability-weighted)',
  AR_PROMISES: 'Promises to pay',
  AP_BILLS: 'Vendor bills',
  AP_PAYMENT_RUNS: 'Approved payment runs',
  PAYROLL: 'Pay runs',
  TRANSFERS: 'Transfers in flight',
  RECURRING: 'Recurring journals',
  PLANNED: 'Planned items',
};

/** Rolling cash forecast with scenarios plus the planned items that feed it. */
export function CashForecastPage() {
  const [asOf, setAsOf] = React.useState(today());
  const [horizonDays, setHorizon] = React.useState(90);
  const [granularity, setGranularity] = React.useState<ForecastGranularity>('WEEK');
  const [scenario, setScenario] = React.useState<ForecastScenario>('BASE');
  const [save, setSave] = React.useState(false);
  const forecast = useCashForecast({
    asOf,
    horizonDays,
    granularity,
    scenario,
    save: save || undefined,
  });
  const snapshots = useForecastSnapshots();
  const f = forecast.data;
  const n = (v: string) => Number(Money.of(v, f?.currency ?? 'PHP').toString());

  React.useEffect(() => {
    if (save && f?.snapshotId) {
      toast.success('Forecast snapshot saved.');
      setSave(false);
      void snapshots.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f?.snapshotId]);

  return (
    <>
      <PageHeader
        title="Cash Forecast"
        description="Opening cash is the ledger; inflows and outflows come from open receivables (weighted by collection probability), payables, approved payment runs, transfers in flight, recurring journals and planned items."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-40"
              aria-label="As of"
            />
            <Select value={String(horizonDays)} onValueChange={(v) => setHorizon(Number(v))}>
              <SelectTrigger className="w-32" aria-label="Horizon">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[30, 60, 90, 180, 365].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={granularity}
              onValueChange={(v) => setGranularity(v as ForecastGranularity)}
            >
              <SelectTrigger className="w-28" aria-label="Granularity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORECAST_GRANULARITIES.map((g) => (
                  <SelectItem key={g} value={g}>
                    {titleCase(g)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={scenario} onValueChange={(v) => setScenario(v as ForecastScenario)}>
              <SelectTrigger className="w-36" aria-label="Scenario">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORECAST_SCENARIOS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Can permissions={[P['treasury.forecast-manage']]}>
              <Button
                size="sm"
                variant="outline"
                disabled={forecast.isFetching}
                onClick={() => setSave(true)}
              >
                <Save /> Save snapshot
              </Button>
            </Can>
          </div>
        }
      />
      <QueryState query={forecast}>
        {(f) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                label="Opening cash"
                value={f.openingCash}
                currency={f.currency}
                hint={`as of ${f.asOf}`}
              />
              <Kpi
                label="Inflows"
                value={f.totals.inflows}
                currency={f.currency}
                tone="success"
                hint={`${titleCase(f.scenario)} scenario`}
              />
              <Kpi
                label="Outflows"
                value={f.totals.outflows}
                currency={f.currency}
                tone="warning"
              />
              <Kpi
                label="Lowest closing"
                value={f.totals.minimumClosing}
                currency={f.currency}
                tone={f.totals.breaches ? 'danger' : 'success'}
                hint={
                  f.totals.breaches
                    ? `${f.totals.breaches} period(s) under the ${formatMoney(f.minimumCash, f.currency)} floor`
                    : `above the ${formatMoney(f.minimumCash, f.currency)} floor`
                }
              />
            </div>
            <LineChart
              title="Projected balance"
              description={`Closing cash per ${f.granularity.toLowerCase()} against the liquidity floor`}
              categories={f.buckets.map((b) => b.label)}
              series={[
                { name: 'Closing', values: f.buckets.map((b) => n(b.closing)) },
                { name: 'Floor', values: f.buckets.map(() => n(f.minimumCash)) },
              ]}
            />
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader>
                  <CardTitle className="text-sm">Periods</CardTitle>
                  <CardDescription>
                    Each period opens with the previous closing balance.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Period</TableHead>
                        <TableHead className="text-right">Opening</TableHead>
                        <TableHead className="text-right">Inflows</TableHead>
                        <TableHead className="text-right">Outflows</TableHead>
                        <TableHead className="text-right">Closing</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {f.buckets.map((b) => (
                        <TableRow key={b.key} className={b.breach ? 'bg-critical/5' : undefined}>
                          <TableCell>
                            <div className="font-medium">{b.label}</div>
                            <div className="text-xs text-muted-foreground">
                              {b.start} to {b.end}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Amount value={b.opening} />
                          </TableCell>
                          <TableCell>
                            <Amount value={b.inflows} className="text-success" zeroAsDash />
                          </TableCell>
                          <TableCell>
                            <Amount value={b.outflows} className="text-destructive" zeroAsDash />
                          </TableCell>
                          <TableCell>
                            <Amount
                              value={b.closing}
                              className={b.breach ? 'font-semibold text-destructive' : undefined}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">By source</CardTitle>
                    <CardDescription>Totals over the horizon.</CardDescription>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableBody>
                        {f.bySource.map((s) => (
                          <TableRow key={`${s.direction}:${s.source}`}>
                            <TableCell>
                              <div className="text-sm">
                                {SOURCE_LABEL[s.source] ?? titleCase(s.source)}
                              </div>
                              <div className="text-xs text-muted-foreground">{s.items} item(s)</div>
                            </TableCell>
                            <TableCell>
                              <Amount
                                value={s.amount}
                                className={
                                  s.direction === 'INFLOW' ? 'text-success' : 'text-destructive'
                                }
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Largest flows</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableBody>
                        {f.topFlows.slice(0, 8).map((x, i) => (
                          <TableRow key={`${x.reference}-${i}`}>
                            <TableCell>
                              <div className="truncate text-sm">{x.label}</div>
                              <div className="text-xs text-muted-foreground">
                                {x.date} - {x.reference}
                                {x.probability !== undefined && x.probability < 1
                                  ? ` - ${Math.round(x.probability * 100)}%`
                                  : ''}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Amount
                                value={x.amount}
                                className={
                                  x.direction === 'INFLOW' ? 'text-success' : 'text-destructive'
                                }
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </div>
            <PlannedItemsCard />
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Saved snapshots</CardTitle>
                <CardDescription>
                  Earlier forecasts kept for accuracy tracking; the daily sweep saves the base case.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Saved</TableHead>
                      <TableHead>As of</TableHead>
                      <TableHead>Scenario</TableHead>
                      <TableHead className="text-right">Opening</TableHead>
                      <TableHead className="text-right">Closing</TableHead>
                      <TableHead className="text-right">Breaches</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(snapshots.data ?? []).map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="text-xs">
                          {new Date(s.createdAt).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {s.asOf}{' '}
                          <span className="text-xs text-muted-foreground">
                            ({s.horizonDays}d, {s.granularity.toLowerCase()})
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={s.scenario} />
                        </TableCell>
                        <TableCell>
                          <Amount value={s.openingCash} />
                        </TableCell>
                        <TableCell>
                          <Amount value={s.closingCash} />
                        </TableCell>
                        <TableCell className="text-right">{s.breaches}</TableCell>
                      </TableRow>
                    ))}
                    {!snapshots.data?.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={6}
                          className="py-6 text-center text-sm text-muted-foreground"
                        >
                          No snapshots yet.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </QueryState>
    </>
  );
}

// ----------------------------------------------------------- planned items

function PlannedItemsCard() {
  const items = useForecastItems({ pageSize: 100 });
  const update = useUpdateForecastItem();
  const remove = useDeleteForecastItem();
  const [open, setOpen] = React.useState(false);
  const toggle = async (item: CashForecastItem, active: boolean) => {
    try {
      await update.mutateAsync({ id: item.id, active });
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Planned items</CardTitle>
          <CardDescription>
            Payroll, rent, loan repayments, tax remittances and other flows the ledger does not know
            about yet.
          </CardDescription>
        </div>
        <Can permissions={[P['treasury.forecast-manage']]}>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> Planned item
          </Button>
        </Can>
      </CardHeader>
      <CardContent className="p-0">
        {items.data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Item</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Frequency</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Active</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.data.items.map((i) => (
                <TableRow key={i.id} className={i.active ? undefined : 'opacity-60'}>
                  <TableCell>
                    <div className="font-medium">{i.name}</div>
                    <div className="text-xs text-muted-foreground">{i.category ?? '-'}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={i.direction} />
                  </TableCell>
                  <TableCell className="text-xs">{titleCase(i.frequency)}</TableCell>
                  <TableCell className="text-xs">
                    {i.startDate}
                    {i.endDate ? ` to ${i.endDate}` : ''}
                  </TableCell>
                  <TableCell>
                    <Amount value={i.amount} currency={i.currency} />
                  </TableCell>
                  <TableCell>
                    <Can
                      permissions={[P['treasury.forecast-manage']]}
                      fallback={<span className="text-xs">{i.active ? 'Yes' : 'No'}</span>}
                    >
                      <Switch
                        checked={i.active}
                        onCheckedChange={(v) => void toggle(i, v)}
                        aria-label={`Toggle ${i.name}`}
                      />
                    </Can>
                  </TableCell>
                  <TableCell>
                    <Can permissions={[P['treasury.forecast-manage']]}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${i.name}`}
                        onClick={async () => {
                          try {
                            await remove.mutateAsync(i.id);
                            toast.success(`${i.name} removed.`);
                          } catch (err) {
                            toast.error(describeError(err));
                          }
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </Can>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="No planned items"
            description="Add payroll, rent, loan and tax schedules so the forecast sees them."
          />
        )}
      </CardContent>
      <PlannedItemDialog open={open} onOpenChange={setOpen} />
    </Card>
  );
}

function PlannedItemDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateForecastItem();
  const banks = useBankAccounts();
  const [name, setName] = React.useState('');
  const [direction, setDirection] = React.useState<'INFLOW' | 'OUTFLOW'>('OUTFLOW');
  const [amount, setAmount] = React.useState('');
  const [frequency, setFrequency] =
    React.useState<(typeof FORECAST_ITEM_FREQUENCIES)[number]>('MONTHLY');
  const [startDate, setStartDate] = React.useState(today());
  const [endDate, setEndDate] = React.useState('');
  const [bankAccountId, setBank] = React.useState('ANY');
  const [category, setCategory] = React.useState('');
  const [notes, setNotes] = React.useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Planned cash flow</DialogTitle>
          <DialogDescription>
            Planned items never post; they only shape the forecast until the real document exists.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Payroll" />
            </Field>
          </div>
          <Field label="Direction">
            <Select value={direction} onValueChange={(v) => setDirection(v as typeof direction)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OUTFLOW">Outflow (payment)</SelectItem>
                <SelectItem value="INFLOW">Inflow (receipt)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Amount">
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Frequency">
            <Select value={frequency} onValueChange={(v) => setFrequency(v as typeof frequency)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORECAST_ITEM_FREQUENCIES.map((x) => (
                  <SelectItem key={x} value={x}>
                    {titleCase(x)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Bank account" hint="Optional; used when forecasting a single account">
            <Select value={bankAccountId} onValueChange={setBank}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ANY">Any account</SelectItem>
                {(banks.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.code} {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="First occurrence">
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Last occurrence" hint="Blank = open-ended">
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </Field>
          <Field label="Category">
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Payroll, Facilities, Tax..."
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name || !amount || create.isPending}
            onClick={async () => {
              try {
                await create.mutateAsync({
                  name,
                  direction,
                  amount,
                  frequency,
                  startDate,
                  endDate: endDate || null,
                  bankAccountId: bankAccountId === 'ANY' ? null : bankAccountId,
                  category: category || undefined,
                  notes: notes || undefined,
                });
                toast.success(`${name} added to the forecast.`);
                onOpenChange(false);
                setName('');
                setAmount('');
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
