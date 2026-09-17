'use client';
import * as React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { formatMoney } from '@accounting/money';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import {
  useRevenueBacklog,
  useRevenueIntegrity,
  useRevenueRollforward,
  useRevenueWaterfall,
} from '@/lib/api/revenue-hooks';
import { titleCase } from '@/lib/format';
import { Amount, today } from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';
import { METHOD_LABEL } from './policies';

function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Deferred revenue rollforward (proven against the ledger), the 12-month waterfall, backlog by customer and the integrity checks. */
export function RevenueReportsPage() {
  const now = today();
  const [from, setFrom] = React.useState(startOfMonth(now));
  const [to, setTo] = React.useState(now);
  const rollforward = useRevenueRollforward({ from, to });
  const waterfall = useRevenueWaterfall({ from: to, months: 12 });
  const backlog = useRevenueBacklog(to);
  const integrity = useRevenueIntegrity(to);
  return (
    <>
      <PageHeader
        title="Deferred Revenue"
        description="Every figure here is derived from the revenue schedules and proven against the deferred revenue account in the ledger."
        actions={
          <div className="flex gap-2">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
              aria-label="From"
            />
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
              aria-label="To"
            />
          </div>
        }
      />
      <QueryState query={rollforward}>
        {(rf) => (
          <>
            <div className="grid gap-3 sm:grid-cols-5">
              <Kpi label="Opening deferred" value={rf.opening} currency={rf.currency} />
              <Kpi label="Billed (deferred)" value={rf.additions} currency={rf.currency} />
              <Kpi label="Recognized" value={rf.recognized} currency={rf.currency} />
              <Kpi label="Closing deferred" value={rf.closing} currency={rf.currency} />
              <Kpi
                label="Ledger difference"
                value={rf.difference ?? '-'}
                currency={rf.currency}
                raw={rf.difference === null}
                tone={
                  rf.difference === null
                    ? undefined
                    : Number(rf.difference) === 0
                      ? 'success'
                      : 'danger'
                }
                hint={
                  rf.ledgerBalance
                    ? `GL deferred revenue ${formatMoney(rf.ledgerBalance, rf.currency)}`
                    : 'DEFERRED_REVENUE not mapped'
                }
              />
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Rollforward by method</CardTitle>
                <CardDescription>
                  Opening + billed - recognized - voided = closing, {rf.from} to {rf.to}.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Opening</TableHead>
                      <TableHead className="text-right">Billed</TableHead>
                      <TableHead className="text-right">Recognized</TableHead>
                      <TableHead className="text-right">Voided</TableHead>
                      <TableHead className="text-right">Closing</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rf.byMethod.map((m) => (
                      <TableRow key={m.method} data-testid="rollforward-row">
                        <TableCell>
                          {METHOD_LABEL[m.method as keyof typeof METHOD_LABEL] ??
                            titleCase(m.method)}
                        </TableCell>
                        <TableCell>
                          <Amount value={m.opening} currency={rf.currency} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount value={m.additions} currency={rf.currency} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount value={m.recognized} currency={rf.currency} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount value={m.voided} currency={rf.currency} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount value={m.closing} currency={rf.currency} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>Total</TableCell>
                      <TableCell>
                        <Amount value={rf.opening} currency={rf.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount value={rf.additions} currency={rf.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount value={rf.recognized} currency={rf.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount value={rf.voided} currency={rf.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount value={rf.closing} currency={rf.currency} />
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </QueryState>
      <QueryState query={waterfall}>
        {(wf) => (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                Waterfall - when the deferred balance becomes revenue
              </CardTitle>
              <CardDescription>
                {wf.months} months from {wf.from}; overdue lines land in the first month, milestones
                without an expected date under unscheduled.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Customer</TableHead>
                    {wf.buckets.map((b) => (
                      <TableHead key={b.month} className="text-right">
                        {b.month}
                      </TableHead>
                    ))}
                    <TableHead className="text-right">Beyond</TableHead>
                    <TableHead className="text-right">Unscheduled</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {wf.byCustomer.map((c) => (
                    <TableRow key={c.customerId} data-testid="waterfall-row">
                      <TableCell>
                        {c.customerCode} {c.customerName}
                      </TableCell>
                      {c.buckets.map((amount, i) => (
                        <TableCell key={i}>
                          <Amount value={amount} currency={wf.currency} zeroAsDash />
                        </TableCell>
                      ))}
                      <TableCell>
                        <Amount value={c.beyond} currency={wf.currency} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={c.unscheduled} currency={wf.currency} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={c.total} currency={wf.currency} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    {wf.buckets.map((b) => (
                      <TableCell key={b.month}>
                        <Amount value={b.amount} currency={wf.currency} zeroAsDash />
                      </TableCell>
                    ))}
                    <TableCell>
                      <Amount value={wf.beyond} currency={wf.currency} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={wf.unscheduled} currency={wf.currency} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={wf.total} currency={wf.currency} />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        )}
      </QueryState>
      <div className="grid gap-4 lg:grid-cols-2">
        <QueryState query={backlog}>
          {(b) => (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Backlog by customer as of {b.asOf}</CardTitle>
                <CardDescription>
                  Contracted but unearned: {b.totals.schedules} open schedule(s), overdue = due but
                  not yet run.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Customer</TableHead>
                      <TableHead className="text-right">Deferred</TableHead>
                      <TableHead className="text-right">Due 30 days</TableHead>
                      <TableHead className="text-right">Overdue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {b.rows.map((r) => (
                      <TableRow key={r.customerId} data-testid="backlog-row">
                        <TableCell>
                          <Link
                            href={`/revenue/schedules?customerId=${r.customerId}`}
                            className="underline"
                          >
                            {r.customerCode} {r.customerName}
                          </Link>
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({r.schedules})
                          </span>
                        </TableCell>
                        <TableCell>
                          <Amount value={r.deferred} currency={b.currency} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.dueWithin30Days} currency={b.currency} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount
                            value={r.overdue}
                            currency={b.currency}
                            zeroAsDash
                            className={Number(r.overdue) ? 'text-destructive' : undefined}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>Total</TableCell>
                      <TableCell>
                        <Amount value={b.totals.deferred} currency={b.currency} />
                      </TableCell>
                      <TableCell>
                        <Amount value={b.totals.dueWithin30Days} currency={b.currency} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={b.totals.overdue} currency={b.currency} zeroAsDash />
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </CardContent>
            </Card>
          )}
        </QueryState>
        <QueryState query={integrity}>
          {(rep) => (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ShieldCheck className="h-4 w-4" /> Integrity <StatusBadge status={rep.status} />
                </CardTitle>
                <CardDescription>
                  Deferred revenue in the ledger must equal the open schedule lines.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Check</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead className="text-right">Findings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rep.findings.map((f) => (
                      <TableRow key={f.check} data-testid="integrity-row">
                        <TableCell>
                          <div className="text-sm">{f.title}</div>
                          <div className="font-mono text-[11px] text-muted-foreground">
                            {f.check}
                            {f.detail ? ` - ${f.detail}` : ''}
                          </div>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={f.severity} />
                        </TableCell>
                        <TableCell
                          className={`text-right ${f.count ? 'text-destructive' : 'text-positive'}`}
                        >
                          {f.count}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </QueryState>
      </div>
    </>
  );
}
