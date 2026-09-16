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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useTreasuryDashboard } from '@/lib/api/treasury-hooks';
import { titleCase } from '@/lib/format';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { BarChart, Kpi, LineChart, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from './shared';

/** Executive cash dashboard: every figure is the GL through the treasury API - nothing is stored. */
export function TreasuryDashboardPage() {
  const [asOf, setAsOf] = React.useState(today());
  const dashboard = useTreasuryDashboard(asOf);
  const d = dashboard.data;
  const n = (v: string) => Number(Money.of(v, d?.currency ?? 'PHP').toString());
  const money = (v: string) => formatMoney(v, d?.currency);

  return (
    <>
      <PageHeader
        title="Cash Dashboard"
        description="Cash position, days cash on hand, the rolling forecast, bank reconciliation backlog, transfers in flight and petty cash - derived from posted journals."
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
      <QueryState query={dashboard}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                label="Total cash"
                value={d.kpis.totalCash}
                currency={d.currency}
                hint={`${money(d.kpis.availableCash)} available incl. overdraft lines`}
              />
              <Kpi
                label="Days cash on hand"
                value={d.kpis.daysCashOnHand === null ? 'n/a' : `${d.kpis.daysCashOnHand} days`}
                raw
                tone={
                  d.kpis.daysCashOnHand !== null &&
                  d.kpis.daysCashOnHand < d.kpis.minimumDaysCashOnHand
                    ? 'danger'
                    : 'success'
                }
                hint={`policy floor ${d.kpis.minimumDaysCashOnHand} days of average outflow`}
              />
              <Kpi
                label="Net cash next 30 days"
                value={d.kpis.net30}
                currency={d.currency}
                tone={n(d.kpis.net30) < 0 ? 'warning' : 'success'}
                hint={`${money(d.kpis.net90)} over 90 days`}
              />
              <Kpi
                label="Lowest forecast balance"
                value={d.kpis.minimumClosing}
                currency={d.currency}
                tone={d.kpis.breaches ? 'danger' : 'success'}
                hint={
                  d.kpis.breaches
                    ? `${d.kpis.breaches} period(s) below the ${money(d.forecast.minimumCash)} floor`
                    : `stays above the ${money(d.forecast.minimumCash)} floor`
                }
              />
              <Kpi
                label="In transit"
                value={d.kpis.inTransit}
                currency={d.currency}
                tone={d.transfers.unsettled.length ? 'warning' : undefined}
                hint={`${d.transfers.inTransit} transfer(s) sent, ${d.transfers.unsettled.length} overdue for settlement`}
              />
              <Kpi
                label="Petty cash imprest"
                value={d.kpis.pettyCash}
                currency={d.currency}
                tone={d.pettyCash.needingReplenishment ? 'warning' : undefined}
                hint={`${d.pettyCash.funds.length} fund(s), ${d.pettyCash.needingReplenishment} due for replenishment, ${d.pettyCash.pendingVouchers} voucher(s) pending`}
              />
              <Kpi
                label="Unreconciled bank lines"
                value={d.unreconciled.count}
                tone={d.unreconciled.count ? 'warning' : 'success'}
                hint={`${money(d.unreconciled.total)} on statements not yet matched to the books`}
              />
              <Kpi
                label="Accounts below minimum"
                value={d.kpis.accountsBelowMinimum}
                tone={d.kpis.accountsBelowMinimum ? 'danger' : 'success'}
                hint={`${d.paymentFiles.generated} payment file(s) to transmit, ${d.paymentFiles.rejected} rejected`}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <LineChart
                title="Cash forecast"
                description={`Projected closing balance per week against the ${money(d.forecast.minimumCash)} liquidity floor (base case)`}
                categories={d.forecast.buckets.map((b) => b.label)}
                series={[
                  { name: 'Closing', values: d.forecast.buckets.map((b) => n(b.closing)) },
                  {
                    name: 'Floor',
                    values: d.forecast.buckets.map(() => n(d.forecast.minimumCash)),
                  },
                ]}
              />
              <BarChart
                title="Inflows vs outflows"
                description="Forecast receipts and payments per week"
                categories={d.forecast.buckets.map((b) => b.label)}
                series={[
                  { name: 'Inflows', values: d.forecast.buckets.map((b) => n(b.inflows)) },
                  { name: 'Outflows', values: d.forecast.buckets.map((b) => n(b.outflows)) },
                ]}
              />
              <BarChart
                title="Cash by bank"
                description={`Book balances in ${d.currency} as of ${d.asOf}`}
                categories={d.position.byBank.map((b) => b.bankName)}
                series={[
                  { name: 'Balance', values: d.position.byBank.map((b) => n(b.baseBalance)) },
                ]}
              />
              <BarChart
                title="Unreconciled statement lines"
                description="Bank statement lines without a book match, by age"
                categories={d.unreconciled.aging.map((b) => b.bucket)}
                series={[{ name: 'Amount', values: d.unreconciled.aging.map((b) => n(b.amount)) }]}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-sm">Bank accounts</CardTitle>
                    <CardDescription>
                      Book balance is the GL; the minimum comes from each account profile.
                    </CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/treasury/position">
                      Cash position <ArrowRight />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Account</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Book</TableHead>
                        <TableHead className="text-right">Minimum</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.position.accounts.map((a) => (
                        <TableRow
                          key={a.bankAccountId}
                          className={a.belowMinimum ? 'bg-critical/5' : undefined}
                        >
                          <TableCell>
                            <div className="font-medium">{a.code}</div>
                            <div className="text-xs text-muted-foreground">
                              {a.bankName ?? a.name} - {a.currency}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">{titleCase(a.accountType)}</TableCell>
                          <TableCell>
                            <Amount
                              value={a.bookBalance}
                              currency={a.currency}
                              className={a.belowMinimum ? 'text-destructive' : undefined}
                            />
                          </TableCell>
                          <TableCell>
                            <Amount value={a.minimumBalance} currency={a.currency} zeroAsDash />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="text-sm">Needs attention</CardTitle>
                    <CardDescription>
                      Transfers past their expected settlement and funds to replenish.
                    </CardDescription>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href="/treasury/transfers">
                      Transfers <ArrowRight />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Item</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.transfers.unsettled.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>
                            <Link
                              href={`/treasury/transfers/${t.id}`}
                              className="font-mono text-sm hover:underline"
                            >
                              {t.documentNumber}
                            </Link>
                            <div className="text-xs text-muted-foreground">
                              {t.fromCode} to {t.toCode}, expected {t.expectedSettlementDate}
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={t.status} />
                          </TableCell>
                          <TableCell>
                            <Amount value={t.amount} currency={t.fromCurrency} />
                          </TableCell>
                        </TableRow>
                      ))}
                      {d.pettyCash.funds
                        .filter((f) => f.replenishmentDue)
                        .map((f) => (
                          <TableRow key={f.id}>
                            <TableCell>
                              <Link
                                href="/treasury/petty-cash"
                                className="font-medium hover:underline"
                              >
                                {f.code} {f.name}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {money(f.expectedCashOnHand)} of {money(f.imprestAmount)} imprest
                                left
                              </div>
                            </TableCell>
                            <TableCell>
                              <StatusBadge status="WARNING" />
                            </TableCell>
                            <TableCell>
                              <Amount value={f.unreplenished} currency={f.currency} />
                            </TableCell>
                          </TableRow>
                        ))}
                      {!d.transfers.unsettled.length && !d.pettyCash.needingReplenishment ? (
                        <TableRow>
                          <TableCell
                            colSpan={3}
                            className="py-8 text-center text-sm text-muted-foreground"
                          >
                            Nothing waiting on treasury.
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </QueryState>
    </>
  );
}
