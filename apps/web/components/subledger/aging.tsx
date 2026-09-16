'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@accounting/ui';
import { useAging, useReconciliation, useSchedule } from '@/lib/api/subledger-hooks';
import { useSession } from '@/lib/auth/session';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function AgingPage({ cfg }: { cfg: SubledgerConfig }) {
  const { activeCompany } = useSession();
  const [asOf, setAsOf] = React.useState(today());
  const aging = useAging(cfg, { asOf }, Boolean(asOf));
  const currency = aging.data?.currency;

  return (
    <>
      <PageHeader
        title={cfg.reports.agingTitle}
        description={`${activeCompany?.name ?? ''} - open ${cfg.document.plural.toLowerCase()} by days past due, and the subledger tied back to the ${cfg.side === 'AR' ? 'receivables' : 'payables'} control account.`}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="aging-as-of">As of</Label>
              <Input
                id="aging-as-of"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="w-44"
              />
            </div>
            <p className="pb-2 text-xs text-muted-foreground">
              Balances are computed as they stood on this date: later{' '}
              {cfg.payment.plural.toLowerCase()} and reversals are ignored.
            </p>
          </CardContent>
        </Card>
        <ReconciliationCard cfg={cfg} asOf={asOf} />
      </div>

      <Card>
        <CardContent className="p-0">
          {aging.isLoading || !aging.data ? (
            <TableSkeleton columns={8} rows={6} />
          ) : (
            <Table data-testid="aging-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{cfg.party.singular}</TableHead>
                  {aging.data.buckets.map((b) => (
                    <TableHead key={b.key} className="w-32 text-right">
                      {b.label}
                    </TableHead>
                  ))}
                  <TableHead className="w-36 text-right">Outstanding</TableHead>
                  <TableHead className="w-36 text-right">Unapplied credit</TableHead>
                  <TableHead className="w-36 text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {aging.data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={4 + aging.data.buckets.length}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Nothing outstanding as of {aging.data.asOf}.
                    </TableCell>
                  </TableRow>
                ) : (
                  aging.data.rows.map((r) => (
                    <TableRow key={r.partyId}>
                      <TableCell>
                        <Link href={`${cfg.party.path}/${r.partyId}`} className="hover:underline">
                          <span className="font-mono text-xs text-muted-foreground">{r.code}</span>{' '}
                          {r.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {r.documents} open {r.documents === 1 ? 'document' : 'documents'}
                          {r.oldestDueDate ? ` - oldest due ${r.oldestDueDate}` : ''}
                        </div>
                      </TableCell>
                      {aging.data!.buckets.map((b) => (
                        <TableCell key={b.key}>
                          <Amount
                            value={r.buckets[b.key] ?? '0'}
                            currency={currency}
                            zeroAsDash
                            className={cn(
                              b.key === 'over90' &&
                                r.buckets[b.key] !== '0.0000' &&
                                'text-critical',
                            )}
                          />
                        </TableCell>
                      ))}
                      <TableCell>
                        <Amount value={r.outstanding} currency={currency} className="font-medium" />
                      </TableCell>
                      <TableCell>
                        <Amount value={r.unappliedCredit} currency={currency} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={r.net} currency={currency} className="font-semibold" />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">
                    Total ({aging.data.currency})
                  </TableCell>
                  {aging.data.buckets.map((b) => (
                    <TableCell key={b.key}>
                      <Amount
                        value={aging.data!.totals[b.key] ?? '0'}
                        currency={currency}
                        className="font-semibold"
                        zeroAsDash
                      />
                    </TableCell>
                  ))}
                  <TableCell>
                    <Amount
                      value={aging.data.totals.outstanding}
                      currency={currency}
                      className="font-semibold"
                    />
                  </TableCell>
                  <TableCell>
                    <Amount
                      value={aging.data.totals.unappliedCredit}
                      currency={currency}
                      className="font-semibold"
                      zeroAsDash
                    />
                  </TableCell>
                  <TableCell>
                    <Amount
                      value={aging.data.totals.net}
                      currency={currency}
                      className="font-semibold"
                    />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>

      {cfg.reports.scheduleApi ? <ScheduleCard cfg={cfg} /> : null}
    </>
  );
}

export function ReconciliationCard({ cfg, asOf }: { cfg: SubledgerConfig; asOf: string }) {
  const rec = useReconciliation(cfg, asOf, Boolean(asOf));
  const r = rec.data;
  return (
    <Card data-testid="reconciliation-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {r ? (
            r.reconciled ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : (
              <XCircle className="h-4 w-4 text-critical" />
            )
          ) : null}
          Subledger vs. control account
        </CardTitle>
        {r ? (
          <CardDescription>
            <span className="font-mono text-xs">{r.controlAccount.code}</span>{' '}
            {r.controlAccount.name} as of {r.asOf}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        {!r ? (
          <TableSkeleton columns={2} rows={3} />
        ) : (
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt className="text-muted-foreground">Subledger</dt>
            <dd>
              <Amount value={r.subledgerBalance} currency={r.currency} />
            </dd>
            <dt className="text-muted-foreground">General ledger</dt>
            <dd>
              <Amount value={r.ledgerBalance} currency={r.currency} />
            </dd>
            <dt className={cn('font-medium', r.reconciled ? 'text-success' : 'text-critical')}>
              {r.reconciled ? 'Reconciled' : 'Difference'}
            </dt>
            <dd>
              <Amount
                value={r.difference}
                currency={r.currency}
                className={cn('font-semibold', !r.reconciled && 'text-critical')}
                zeroAsDash
              />
            </dd>
            {Object.entries(r.breakdown).map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="pl-3 text-xs text-muted-foreground">
                  {titleCase(k.replace(/([a-z])([A-Z])/g, '$1_$2'))}
                </dt>
                <dd>
                  <Amount value={v} currency={r.currency} className="text-xs" zeroAsDash />
                </dd>
              </React.Fragment>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function ScheduleCard({ cfg }: { cfg: SubledgerConfig }) {
  const [to, setTo] = React.useState(addDays(today(), 14));
  const schedule = useSchedule(cfg, to, Boolean(to));
  return (
    <Card>
      <CardHeader className="flex-row items-end justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Payment schedule</CardTitle>
          <CardDescription>
            Open bills due (or scheduled) on or before the chosen date, ordered by pay-on date.
          </CardDescription>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="schedule-to">Through</Label>
          <Input
            id="schedule-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-44"
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {schedule.isLoading || !schedule.data ? (
          <TableSkeleton columns={6} rows={4} />
        ) : schedule.data.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            Nothing due through {schedule.data.to}.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Pay on</TableHead>
                <TableHead>Bill</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="w-36 text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedule.data.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="whitespace-nowrap">{i.payOn}</TableCell>
                  <TableCell>
                    <Link
                      href={`${cfg.document.path}/${i.id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {i.documentNumber}
                    </Link>
                    {i.vendorInvoiceNumber ? (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {i.vendorInvoiceNumber}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Link href={`${cfg.party.path}/${i.vendorId}`} className="hover:underline">
                      {i.vendorName}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{i.dueDate}</TableCell>
                  <TableCell>
                    <Amount value={i.balance} currency={schedule.data!.currency} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={4}
                  className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Total to pay
                </TableCell>
                <TableCell>
                  <Amount
                    value={schedule.data.total}
                    currency={schedule.data.currency}
                    className="font-semibold"
                  />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
