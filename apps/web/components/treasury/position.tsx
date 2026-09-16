'use client';
import * as React from 'react';
import Link from 'next/link';
import { Landmark } from 'lucide-react';
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
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useCashPosition } from '@/lib/api/treasury-hooks';
import { titleCase } from '@/lib/format';
import { EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from './shared';

/** Cash position: per bank account the GL book balance, latest statement, unmatched lines, transfers in flight and profile limits. */
export function CashPositionPage() {
  const [asOf, setAsOf] = React.useState(today());
  const position = useCashPosition({ asOf });

  return (
    <>
      <PageHeader
        title="Cash Position"
        description="Book balances are the bank GL accounts as of the date; statement balances and unmatched lines come from bank reconciliation; in-transit amounts are transfers sent but not yet settled."
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
      <QueryState query={position}>
        {(p) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi label="Book balance" value={p.totals.bookBalance} currency={p.baseCurrency} />
              <Kpi
                label="Available"
                value={p.totals.availableBalance}
                currency={p.baseCurrency}
                hint="book plus overdraft lines"
              />
              <Kpi
                label="In transit"
                value={p.totals.inTransit}
                currency={p.baseCurrency}
                hint="arriving in destination accounts"
              />
              <Kpi
                label="Below minimum"
                value={p.totals.belowMinimum}
                tone={p.totals.belowMinimum ? 'danger' : 'success'}
                hint={`${p.totals.unreconciledCount} unmatched statement line(s); ${p.totals.excluded} account(s) excluded`}
              />
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Bank accounts</CardTitle>
                <CardDescription>
                  Amounts in each account&apos;s currency; the base column converts at the {p.asOf} rate.
                  Edit limits and payment details under{' '}
                  <Link href="/treasury/settings" className="underline">
                    Treasury Settings
                  </Link>
                  .
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {p.accounts.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Account</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Book</TableHead>
                        <TableHead className="text-right">Statement</TableHead>
                        <TableHead className="text-right">Unmatched</TableHead>
                        <TableHead className="text-right">In transit</TableHead>
                        <TableHead className="text-right">Minimum</TableHead>
                        <TableHead className="text-right">Headroom</TableHead>
                        <TableHead className="text-right">Base</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.accounts.map((a) => (
                        <TableRow
                          key={a.bankAccountId}
                          className={a.excludeFromPosition ? 'opacity-60' : undefined}
                        >
                          <TableCell>
                            <Link href="/banking/accounts" className="font-medium hover:underline">
                              {a.code}
                            </Link>
                            <div className="text-xs text-muted-foreground">
                              {a.bankName ?? a.name} - {a.currency}
                              {a.purpose ? ` - ${a.purpose}` : ''}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">{titleCase(a.accountType)}</TableCell>
                          <TableCell>
                            <Amount value={a.bookBalance} currency={a.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={a.statementBalance} currency={a.currency} />
                            {a.statementDate ? (
                              <div className="text-right text-xs text-muted-foreground">
                                {a.statementDate}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            {a.unreconciledCount ? (
                              <div className="text-right text-xs">
                                <div className="text-success">
                                  +{formatMoney(a.unreconciledIn, a.currency)}
                                </div>
                                <div className="text-destructive">
                                  -{formatMoney(a.unreconciledOut, a.currency)}
                                </div>
                                <div className="text-muted-foreground">
                                  {a.unreconciledCount} line(s)
                                </div>
                              </div>
                            ) : (
                              <span className="block text-right text-muted-foreground">-</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="text-right text-xs">
                              {a.inTransitIn !== '0.0000' ? (
                                <div className="text-success">
                                  +{formatMoney(a.inTransitIn, a.currency)}
                                </div>
                              ) : null}
                              {a.inTransitOut !== '0.0000' ? (
                                <div className="text-muted-foreground">
                                  -{formatMoney(a.inTransitOut, a.currency)}
                                </div>
                              ) : null}
                              {a.inTransitIn === '0.0000' && a.inTransitOut === '0.0000' ? (
                                <span className="text-muted-foreground">-</span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Amount value={a.minimumBalance} currency={a.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount
                              value={a.headroom}
                              currency={a.currency}
                              className={a.belowMinimum ? 'text-destructive' : undefined}
                            />
                          </TableCell>
                          <TableCell>
                            <Amount value={a.baseBalance} currency={p.baseCurrency} />
                          </TableCell>
                          <TableCell>
                            {a.excludeFromPosition ? (
                              <StatusBadge status="EXCLUDED" />
                            ) : a.belowMinimum ? (
                              <StatusBadge status="CRITICAL" />
                            ) : (
                              <StatusBadge status="OK" />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState
                    icon={Landmark}
                    title="No bank accounts"
                    description="Create bank accounts under Finance to see a cash position."
                  />
                )}
              </CardContent>
            </Card>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By currency</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Currency</TableHead>
                        <TableHead>Accounts</TableHead>
                        <TableHead className="text-right">Balance</TableHead>
                        <TableHead className="text-right">{p.baseCurrency}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.byCurrency.map((c) => (
                        <TableRow key={c.currency}>
                          <TableCell className="font-medium">{c.currency}</TableCell>
                          <TableCell>{c.accounts}</TableCell>
                          <TableCell>
                            <Amount value={c.balance} currency={c.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={c.baseBalance} currency={p.baseCurrency} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By bank</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Bank</TableHead>
                        <TableHead>Accounts</TableHead>
                        <TableHead className="text-right">{p.baseCurrency}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {p.byBank.map((b) => (
                        <TableRow key={b.bankName}>
                          <TableCell className="font-medium">{b.bankName}</TableCell>
                          <TableCell>{b.accounts}</TableCell>
                          <TableCell>
                            <Amount value={b.baseBalance} currency={p.baseCurrency} />
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
    </>
  );
}
