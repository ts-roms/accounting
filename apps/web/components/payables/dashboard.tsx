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
import { useApDashboard } from '@/lib/api/payables-hooks';
import { AP_CONFIG } from '@/lib/subledger/config';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { BarChart, Kpi, LineChart } from '@/components/receivables/shared';

/** Executive AP dashboard: every figure comes from the posted subledger through the API. */
export function ApDashboardPage() {
  const [asOf, setAsOf] = React.useState(today());
  const dashboard = useApDashboard(asOf);
  const d = dashboard.data;
  const n = (v: string) => Number(Money.of(v, d?.currency ?? 'PHP').toString());
  const money = (v: string) => formatMoney(v, d?.currency);

  return (
    <>
      <PageHeader
        title="AP Dashboard"
        description="Payables, cash requirements, discounts, holds and received-not-billed derived from posted documents."
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
            <Kpi label="Total payables" value={d.totals.totalPayables} currency={d.currency} />
            <Kpi
              label="Overdue"
              value={d.totals.overdue}
              currency={d.currency}
              tone={n(d.totals.overdue) > 0 ? 'danger' : undefined}
              hint={`${money(d.totals.current)} current`}
            />
            <Kpi
              label={`Due in ${d.totals.dueSoonDays} days`}
              value={d.totals.dueSoon}
              currency={d.currency}
              tone={n(d.totals.dueSoon) > 0 ? 'warning' : undefined}
              hint={`${money(d.totals.unappliedCredits)} unapplied credits`}
            />
            <Kpi
              label="DPO"
              value={d.totals.dpo}
              hint={`days, ${d.totals.dpoWindowDays}-day countback`}
              tone={d.totals.dpo > 90 ? 'warning' : undefined}
            />
            <Kpi
              label="Discounts available"
              value={d.totals.discountsAvailable}
              currency={d.currency}
              tone={d.totals.discountsExpiringCount ? 'warning' : 'success'}
              hint={
                d.totals.discountsExpiringCount
                  ? `${d.totals.discountsExpiringCount} lapsing soon: ${money(d.totals.discountsExpiring)}`
                  : `${Math.round(d.totals.discountCaptureRate * 100)}% captured over the window`
              }
            />
            <Kpi
              label="On payment hold"
              value={d.totals.onHold}
              currency={d.currency}
              tone={d.totals.onHoldCount ? 'warning' : undefined}
              hint={`${d.totals.onHoldCount} bill(s) held, ${d.totals.vendorsOnHold} vendor(s) on hold`}
            />
            <Kpi
              label="Received not billed"
              value={d.totals.grni}
              currency={d.currency}
              tone={n(d.totals.grniAged) > 0 ? 'warning' : undefined}
              hint={n(d.totals.grniAged) > 0 ? `${money(d.totals.grniAged)} aged` : 'nothing aged'}
            />
            <Kpi
              label="Awaiting action"
              value={
                d.totals.billsAwaitingApproval +
                d.totals.pendingPaymentRuns +
                d.totals.vendorsPendingApproval
              }
              hint={`${d.totals.billsAwaitingApproval} bills to approve, ${d.totals.pendingPaymentRuns} run(s) ${money(d.totals.pendingPaymentRunsAmount)}, ${d.totals.vendorsPendingApproval} vendor(s) pending`}
              tone={d.totals.pendingPaymentRuns ? 'warning' : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BarChart
              title="AP aging"
              description={`Open balances by days past due as of ${d.asOf}`}
              categories={d.aging.map((b) => b.label)}
              series={[{ name: 'Outstanding', values: d.aging.map((b) => n(b.amount)) }]}
            />
            <BarChart
              title="Cash requirements"
              description="Cash needed to settle open bills by horizon (held bills excluded)"
              categories={d.cashRequirements.map((b) => b.label)}
              series={[
                { name: 'Due', values: d.cashRequirements.map((b) => n(b.amount)) },
                {
                  name: 'Discount available',
                  values: d.cashRequirements.map((b) => n(b.discountAvailable)),
                },
              ]}
            />
            <LineChart
              title="Billed vs paid"
              description="Monthly purchases on account against payments posted"
              categories={d.paymentsTrend.map((m) => m.month)}
              series={[
                { name: 'Billed', values: d.paymentsTrend.map((m) => n(m.billed)) },
                { name: 'Paid', values: d.paymentsTrend.map((m) => n(m.paid)) },
              ]}
            />
            <LineChart
              title="DPO trend"
              description="Days payable outstanding at each month end"
              categories={d.dpoTrend.map((m) => m.month)}
              series={[{ name: 'DPO', values: d.dpoTrend.map((m) => m.dpo) }]}
              format={(v) => `${Math.round(v)}d`}
            />
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-sm">Largest vendor balances</CardTitle>
                <CardDescription>Who gets paid first when cash is tight.</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/payables/cash-requirements">
                  Cash requirements <ArrowRight />
                </Link>
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Vendor</TableHead>
                    <TableHead>Oldest due</TableHead>
                    <TableHead className="text-right">Overdue</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.topVendors.length ? (
                    d.topVendors.map((r) => (
                      <TableRow key={r.vendorId}>
                        <TableCell>
                          <Link
                            href={`${AP_CONFIG.party.path}/${r.vendorId}`}
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
                        Nothing outstanding.
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
