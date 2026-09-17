'use client';
import * as React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
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
import { useBankFeedDashboard, useBankFeedIntegrity } from '@/lib/api/bank-feed-hooks';
import { formatDateTime } from '@/lib/format';
import { Amount, today } from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';

/** Reconciliation KPIs: how much of the feed explains itself, what waits, how old it is, which rules work. */
export function BankFeedDashboardPage() {
  const [asOf, setAsOf] = React.useState(today());
  const [days, setDays] = React.useState('30');
  const dashboard = useBankFeedDashboard(asOf, Number(days) || 30);
  const integrity = useBankFeedIntegrity(asOf);
  return (
    <>
      <PageHeader
        title="Bank Feed KPIs"
        description="Imported lines in the window, how they were explained (matcher, rules, documents, by hand) and what is still waiting."
        actions={
          <div className="flex gap-2">
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-40"
              aria-label="As of"
            />
            <Input
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-20"
              aria-label="Days"
            />
            <Button variant="outline" size="sm" asChild>
              <Link href="/banking/feed">Review queue</Link>
            </Button>
          </div>
        }
      />
      <QueryState query={dashboard}>
        {(d) => (
          <>
            <div className="grid gap-3 sm:grid-cols-6">
              <Kpi label={`Imported (${d.days}d)`} value={d.imported} />
              <Kpi
                label="Explained"
                value={d.explained}
                hint={`${d.autoMatched} matcher, ${d.ruleApplied} rules, ${d.documentApplied} documents, ${d.manual} by hand`}
              />
              <Kpi
                label="Automation rate"
                value={`${d.automationRate}%`}
                raw
                tone={Number(d.automationRate) >= 70 ? 'success' : 'warning'}
                hint="explained without a person"
              />
              <Kpi
                label="Waiting"
                value={d.pendingLines}
                tone={d.pendingLines ? 'warning' : 'success'}
                hint={`${d.pendingSuggestions} with suggestions`}
              />
              <Kpi
                label="Stale"
                value={d.staleLines}
                tone={d.staleLines ? 'danger' : 'success'}
                hint="older than the grace period"
              />
              <Kpi
                label="Rules firing"
                value={d.topRules.reduce((n, r) => n + r.hitCount, 0)}
                hint="hits across rules"
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By bank account</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Account</TableHead>
                        <TableHead>Imported</TableHead>
                        <TableHead>Waiting</TableHead>
                        <TableHead className="text-right">In / out</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.byBankAccount.map((b) => (
                        <TableRow key={b.bankAccountId} data-testid="feed-bank-row">
                          <TableCell>{b.code}</TableCell>
                          <TableCell>{b.imported}</TableCell>
                          <TableCell>{b.unexplained}</TableCell>
                          <TableCell className="text-right text-xs">
                            <Amount value={b.unexplainedIn} currency={d.currency} zeroAsDash />
                            <Amount value={b.unexplainedOut} currency={d.currency} zeroAsDash />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Waiting by age</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Age</TableHead>
                        <TableHead>Lines</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.ageing.map((a) => (
                        <TableRow key={a.bucket}>
                          <TableCell>{a.bucket}</TableCell>
                          <TableCell>{a.lines}</TableCell>
                          <TableCell>
                            <Amount value={a.amount} currency={d.currency} zeroAsDash />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Top rules</CardTitle>
                  <CardDescription>Most hits since creation.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Rule</TableHead>
                        <TableHead>Hits</TableHead>
                        <TableHead>Last</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.topRules.map((r) => (
                        <TableRow key={r.id} data-testid="feed-rule-hit">
                          <TableCell>{r.name}</TableCell>
                          <TableCell>{r.hitCount}</TableCell>
                          <TableCell className="text-xs">
                            {r.lastHitAt ? formatDateTime(r.lastHitAt) : '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </QueryState>
      <QueryState query={integrity}>
        {(rep) => (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4" /> Integrity <StatusBadge status={rep.status} />
              </CardTitle>
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
                    <TableRow key={f.check} data-testid="feed-integrity-row">
                      <TableCell>
                        <div className="text-sm">{f.title}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{f.check}</div>
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
    </>
  );
}
