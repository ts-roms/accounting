'use client';
import * as React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@accounting/ui';
import { useLeaseDashboard, useLeaseMaturity, useLeaseRegister } from '@/lib/api/lease-hooks';
import { Amount, today } from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';
import { ClassificationBadge, LEASES_PATH, LeaseStatusBadge, Stat, frequencyLabel } from './shared';

const money = (v: string) =>
  Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Register, maturity analysis and the KPI / integrity view, all derived from the schedule and proven against the ledger. */
export function LeaseReportsPage() {
  const [asOf, setAsOf] = React.useState(today());
  const register = useLeaseRegister(asOf);
  const maturity = useLeaseMaturity(asOf);
  const dashboard = useLeaseDashboard(asOf);
  return (
    <>
      <PageHeader
        title="Lease Reports"
        description="The lease register with liability and right-of-use carrying amounts, the undiscounted maturity analysis with the current / non-current split, and the integrity checks that prove the register against the ledger."
        actions={
          <div className="flex items-center gap-2">
            <Label className="text-xs">As of</Label>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-40"
            />
          </div>
        }
      />
      <QueryState query={dashboard}>
        {(d) => (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              label="Lease liability"
              value={d.liability}
              currency={d.currency}
              hint={`${d.activeLeases} active lease(s)`}
            />
            <Kpi label="Right-of-use carrying" value={d.rouCarrying} currency={d.currency} />
            <Kpi
              label="Months awaiting a run"
              value={d.monthsAwaitingRun}
              raw
              tone={d.monthsAwaitingRun ? 'warning' : 'success'}
              hint="Ended months not yet posted"
            />
            <Kpi
              label="Overdue instalments"
              value={d.overduePaymentAmount}
              currency={d.currency}
              tone={d.overduePayments ? 'danger' : 'success'}
              hint={`${d.overduePayments} instalment(s) · ${money(d.next30DaysPayments)} due in 30 days`}
            />
          </div>
        )}
      </QueryState>
      <Tabs defaultValue="register">
        <TabsList>
          <TabsTrigger value="register">Register</TabsTrigger>
          <TabsTrigger value="maturity">Maturity</TabsTrigger>
          <TabsTrigger value="integrity">Integrity</TabsTrigger>
        </TabsList>
        <TabsContent value="register">
          <QueryState query={register}>
            {(r) => (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Lease register</CardTitle>
                  <CardDescription>
                    {r.totals.finance} on balance sheet, {r.totals.exempt} exempt · liability{' '}
                    {money(r.totals.liability)} · right-of-use carrying{' '}
                    {money(r.totals.rouCarrying)}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Lease</TableHead>
                        <TableHead>Term</TableHead>
                        <TableHead className="text-right">Payment</TableHead>
                        <TableHead className="text-right">Liability</TableHead>
                        <TableHead className="text-right">ROU cost</TableHead>
                        <TableHead className="text-right">Accumulated</TableHead>
                        <TableHead className="text-right">Carrying</TableHead>
                        <TableHead className="text-right">Remaining</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.rows.map((row) => (
                        <TableRow key={row.leaseId} data-testid="lease-register-row">
                          <TableCell>
                            <Link
                              href={`${LEASES_PATH}/${row.leaseId}`}
                              className="hover:underline"
                            >
                              <span className="font-mono text-xs">{row.leaseNumber}</span>{' '}
                              {row.name}
                            </Link>
                            <div className="mt-1">
                              <ClassificationBadge classification={row.classification} />
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">
                            {row.commencementDate} → {row.endDate}
                            <div className="text-muted-foreground">
                              {row.termMonths} mo · {frequencyLabel(row.paymentFrequency)}
                              {row.annualDiscountRate
                                ? ` · ${Number(row.annualDiscountRate)}%`
                                : ''}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Amount value={row.paymentAmount} currency={row.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount
                              value={row.liabilityBalance}
                              currency={row.currency}
                              zeroAsDash
                            />
                            {row.currency !== r.currency ? (
                              <div className="text-right text-xs text-muted-foreground">
                                <Amount value={row.liabilityBalanceBase} currency={r.currency} />
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Amount value={row.rouCost} currency={row.currency} zeroAsDash />
                          </TableCell>
                          <TableCell>
                            <Amount
                              value={row.rouAccumulatedDepreciation}
                              currency={row.currency}
                              zeroAsDash
                            />
                          </TableCell>
                          <TableCell>
                            <Amount value={row.rouCarrying} currency={row.currency} zeroAsDash />
                            {row.currency !== r.currency ? (
                              <div className="text-right text-xs text-muted-foreground">
                                <Amount value={row.rouCarryingBase} currency={r.currency} />
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Amount value={row.remainingPayments} zeroAsDash />
                            <div className="text-right text-xs text-muted-foreground">
                              {row.remainingMonths} mo
                              {row.nextPaymentDate ? ` · next ${row.nextPaymentDate}` : ''}
                            </div>
                          </TableCell>
                          <TableCell>
                            <LeaseStatusBadge status={row.status} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell colSpan={3}>Active leases</TableCell>
                        <TableCell>
                          <Amount value={r.totals.liability} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.totals.rouCost} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.totals.rouAccumulatedDepreciation} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.totals.rouCarrying} />
                        </TableCell>
                        <TableCell>
                          <Amount value={r.totals.remainingPayments} />
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  </Table>
                </CardContent>
              </Card>
            )}
          </QueryState>
        </TabsContent>
        <TabsContent value="maturity">
          <QueryState query={maturity}>
            {(m) => (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Stat
                    label="Undiscounted payments"
                    value={<Amount value={m.undiscountedTotal} className="text-left" />}
                  />
                  <Stat
                    label="Lease liability"
                    value={<Amount value={m.liability} className="text-left" />}
                    hint={`Unaccrued interest ${money(m.unaccruedInterest)}`}
                  />
                  <Stat
                    label="Current portion"
                    value={<Amount value={m.currentPortion} className="text-left" />}
                    hint="Principal due within twelve months"
                  />
                  <Stat
                    label="Non-current portion"
                    value={<Amount value={m.nonCurrentPortion} className="text-left" />}
                  />
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Undiscounted maturity</CardTitle>
                      <CardDescription>
                        Instalments still to pay, by year from {m.asOf}.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <Table>
                        <TableBody>
                          {m.buckets.map((b) => (
                            <TableRow key={b.label} data-testid="lease-maturity-row">
                              <TableCell>
                                {b.label}
                                <div className="text-xs text-muted-foreground">
                                  {b.from} → {b.to}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Amount value={b.amount} zeroAsDash />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">By lease</CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead>Lease</TableHead>
                            <TableHead className="text-right">Liability</TableHead>
                            <TableHead className="text-right">Current</TableHead>
                            <TableHead className="text-right">Non-current</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {m.byLease.map((l) => (
                            <TableRow key={l.leaseId}>
                              <TableCell>
                                <span className="font-mono text-xs">{l.leaseNumber}</span> {l.name}
                              </TableCell>
                              <TableCell>
                                <Amount value={l.liability} zeroAsDash />
                              </TableCell>
                              <TableCell>
                                <Amount value={l.currentPortion} zeroAsDash />
                              </TableCell>
                              <TableCell>
                                <Amount value={l.nonCurrentPortion} zeroAsDash />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}
          </QueryState>
        </TabsContent>
        <TabsContent value="integrity">
          <QueryState query={dashboard}>
            {(d) => (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <ShieldCheck className="h-4 w-4" /> Integrity{' '}
                    <StatusBadge status={d.integrity.status} />
                  </CardTitle>
                  <CardDescription>
                    Register vs ledger, schedule totals, overdue runs and instalments as of {d.asOf}
                    .
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
                      {d.integrity.findings.map((f) => (
                        <TableRow key={f.check} data-testid="lease-integrity-row">
                          <TableCell>
                            <div className="text-sm">{f.title}</div>
                            <div className="font-mono text-[11px] text-muted-foreground">
                              {f.check}
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={f.severity} />
                          </TableCell>
                          <TableCell
                            className={`text-right ${f.count ? 'text-critical' : 'text-positive'}`}
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
        </TabsContent>
      </Tabs>
    </>
  );
}
