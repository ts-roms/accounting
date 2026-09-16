'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Money, formatMoney } from '@accounting/money';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useArDashboard } from '@/lib/api/receivables-hooks';
import { AR_CONFIG } from '@/lib/subledger/config';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { BarChart, Kpi, LineChart } from './shared';

/** Executive AR dashboard: every figure comes from the posted subledger through the API. */
export function ArDashboardPage() {
  const [asOf, setAsOf] = React.useState(today());
  const dashboard = useArDashboard(asOf);
  const d = dashboard.data;
  const n = (v: string) => Number(Money.of(v, d?.currency ?? 'PHP').toString());
  const money = (v: string) => formatMoney(v, d?.currency);

  return (
    <>
      <PageHeader
        title="AR Dashboard"
        description="Receivables, aging, collections and credit exposure derived from posted documents."
        actions={
          <Input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="w-40"
            aria-label="As of"
          />
        }
      />
      {!d ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi
              label="Total receivables"
              value={d.totals.totalReceivables}
              currency={d.currency}
            />
            <Kpi label="Current" value={d.totals.current} currency={d.currency} tone="success" />
            <Kpi
              label="Overdue"
              value={d.totals.overdue}
              currency={d.currency}
              tone={n(d.totals.overdue) > 0 ? 'danger' : undefined}
              hint={`${d.topOverdue.length} customers with overdue balances`}
            />
            <Kpi
              label="DSO"
              value={d.totals.dso}
              hint={`days, ${d.totals.dsoWindowDays}-day countback`}
              tone={d.totals.dso > 60 ? 'warning' : undefined}
            />
            <Kpi
              label="Collection rate (30d)"
              value={`${Math.round(d.totals.collectionRate * 100)}%`}
              raw
              hint="collected vs fallen due"
              tone={d.totals.collectionRate < 0.5 ? 'warning' : 'success'}
            />
            <Kpi
              label="Unapplied cash"
              value={d.totals.unappliedCash}
              currency={d.currency}
              hint={
                d.totals.unappliedCashStaleCount
                  ? `${d.totals.unappliedCashStaleCount} receipt(s) stale: ${money(d.totals.unappliedCashStale)}`
                  : 'nothing stale'
              }
              tone={d.totals.unappliedCashStaleCount ? 'warning' : undefined}
            />
            <Kpi
              label="Credit exposure"
              value={d.totals.creditExposure}
              currency={d.currency}
              hint={`of ${money(d.totals.creditLimitTotal)} limits - ${d.totals.customersOverLimit} over, ${d.totals.customersOnHold} on hold`}
            />
            <Kpi
              label="Collections workload"
              value={d.totals.openCases}
              hint={`${d.totals.openDisputes} disputes, ${d.totals.pendingPromises} promises pending, ${d.totals.brokenPromises} broken`}
              tone={d.totals.brokenPromises ? 'danger' : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BarChart
              title="AR aging"
              description={`Open balances by days past due as of ${d.asOf}`}
              categories={d.aging.map((b) => b.label)}
              series={[{ name: 'Outstanding', values: d.aging.map((b) => n(b.amount)) }]}
            />
            <BarChart
              title="Collections trend"
              description="Receipts posted vs credit sales, last six months"
              categories={d.collectionsTrend.map((m) => m.month)}
              series={[
                { name: 'Collected', values: d.collectionsTrend.map((m) => n(m.collected)) },
                { name: 'Invoiced', values: d.collectionsTrend.map((m) => n(m.invoiced)) },
              ]}
            />
            <LineChart
              title="Revenue vs receivables"
              description="Monthly credit sales against month-end open receivables"
              categories={d.revenueVsReceivables.map((m) => m.month)}
              series={[
                { name: 'Revenue', values: d.revenueVsReceivables.map((m) => n(m.revenue)) },
                {
                  name: 'Receivables',
                  values: d.revenueVsReceivables.map((m) => n(m.receivables)),
                },
              ]}
            />
            <LineChart
              title="DSO trend"
              description="Days sales outstanding at each month end"
              categories={d.dsoTrend.map((m) => m.month)}
              series={[{ name: 'DSO', values: d.dsoTrend.map((m) => m.dso) }]}
              format={(v) => `${Math.round(v)}d`}
            />
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-sm">Largest overdue balances</CardTitle>
                <CardDescription>Where the collections effort pays off first.</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/receivables/collections">
                  Collections <ArrowRight />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Customer</TableHead>
                    <TableHead>Oldest due</TableHead>
                    <TableHead className="text-right">Overdue</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.topOverdue.length ? (
                    d.topOverdue.map((r) => (
                      <TableRow key={r.customerId}>
                        <TableCell>
                          <Link
                            href={`${AR_CONFIG.party.path}/${r.customerId}`}
                            className="hover:underline"
                          >
                            {r.name}
                          </Link>
                          <div className="font-mono text-xs text-muted-foreground">{r.code}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.oldestDueDate ?? '-'}
                        </TableCell>
                        <TableCell>
                          <Amount value={r.overdue} className="text-destructive" />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.outstanding} />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Nothing overdue.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
