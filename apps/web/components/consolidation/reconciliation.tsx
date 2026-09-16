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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import {
  useConsolidationGroups,
  useConsolidationIntegrity,
  useIntercompanyReconciliation,
} from '@/lib/api/consolidation-hooks';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';

/** Intercompany reconciliation: what each pair owes each other, and whether the ledgers agree with the register. */
export function IntercompanyReconciliationPage() {
  const [asOf, setAsOf] = React.useState(today());
  const [groupId, setGroupId] = React.useState('ALL');
  const groups = useConsolidationGroups();
  const recon = useIntercompanyReconciliation({
    asOf,
    groupId: groupId === 'ALL' ? undefined : groupId,
  });
  const integrity = useConsolidationIntegrity(asOf);
  return (
    <>
      <PageHeader
        title="Intercompany Reconciliation"
        description="Open charges by company pair from the intercompany register, mirrored on both sides, and each entity's intercompany accounts against what the register expects."
        actions={
          <div className="flex gap-2">
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger className="w-44" aria-label="Group">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All companies</SelectItem>
                {(groups.data ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="w-40"
              aria-label="As of"
            />
          </div>
        }
      />
      <QueryState query={recon}>
        {(r) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Kpi
                label="Open intercompany"
                value={r.totals.openTransactions}
                currency={r.currency}
                hint="posted charges not yet settled"
              />
              <Kpi
                label="Unmatched pairs"
                value={r.totals.unmatchedPairs}
                tone={r.totals.unmatchedPairs ? 'danger' : 'success'}
              />
              <Kpi
                label="Entities with ledger drift"
                value={r.totals.entitiesWithDrift}
                tone={r.totals.entitiesWithDrift ? 'warning' : 'success'}
                hint="intercompany accounts posted outside the register"
              />
            </div>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">By company pair</CardTitle>
                <CardDescription>
                  Manage the charges themselves under{' '}
                  <Link href="/accounting/intercompany" className="underline">
                    Intercompany
                  </Link>
                  .
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Owes</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Charges</TableHead>
                      <TableHead className="text-right">Payable side</TableHead>
                      <TableHead className="text-right">Receivable side</TableHead>
                      <TableHead className="text-right">Difference ({r.currency})</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.pairs.map((p) => (
                      <TableRow key={`${p.fromCompanyId}:${p.toCompanyId}`}>
                        <TableCell className="font-medium">{p.fromCompanyCode}</TableCell>
                        <TableCell className="font-medium">{p.toCompanyCode}</TableCell>
                        <TableCell>{p.count}</TableCell>
                        <TableCell className="text-right">
                          {formatMoney(p.owed, p.owedCurrency)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatMoney(p.receivable, p.receivableCurrency)}
                        </TableCell>
                        <TableCell>
                          <Amount
                            value={p.difference}
                            currency={r.currency}
                            zeroAsDash
                            className={p.difference !== '0.0000' ? 'text-destructive' : undefined}
                          />
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            status={
                              p.status === 'MATCHED'
                                ? 'OK'
                                : p.status === 'DIFFERENCE'
                                  ? 'CRITICAL'
                                  : 'WARNING'
                            }
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                    {!r.pairs.length ? (
                      <TableRow>
                        <TableCell
                          colSpan={7}
                          className="py-6 text-center text-sm text-muted-foreground"
                        >
                          Nothing open between the companies on {r.asOf}.
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Per entity: ledger vs register</CardTitle>
                <CardDescription>
                  Balances of the accounts flagged intercompany compared with the open register; a
                  difference means something bypassed the intercompany module.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Entity</TableHead>
                      <TableHead className="text-right">Receivable (GL)</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Payable (GL)</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.entities.map((e) => {
                      const drift =
                        e.receivableDifference !== '0.0000' || e.payableDifference !== '0.0000';
                      return (
                        <TableRow key={e.companyId}>
                          <TableCell className="font-medium">
                            {e.companyCode}{' '}
                            <span className="text-xs text-muted-foreground">{e.currency}</span>
                          </TableCell>
                          <TableCell>
                            <Amount value={e.receivableLedger} currency={e.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={e.receivableExpected} currency={e.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={e.payableLedger} currency={e.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={e.payableExpected} currency={e.currency} />
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={drift ? 'WARNING' : 'OK'} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </QueryState>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4" /> Consolidation integrity{' '}
            {integrity.data ? <StatusBadge status={integrity.data.status} /> : null}
          </CardTitle>
          <CardDescription>
            Runs balance, adjustments balance, finalized runs still match the member books,
            intercompany postings carry both legs.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!integrity.data ? (
            <Skeleton className="m-4 h-32" />
          ) : (
            <Table>
              <TableBody>
                {integrity.data.findings.map((f) => (
                  <TableRow
                    key={f.check}
                    className={
                      f.count
                        ? f.severity === 'CRITICAL'
                          ? 'bg-critical/5'
                          : 'bg-warning/5'
                        : undefined
                    }
                  >
                    <TableCell>
                      <div className="text-sm">{f.title}</div>
                      <div className="font-mono text-xs text-muted-foreground">{f.check}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={f.count ? f.severity : 'OK'} />
                    </TableCell>
                    <TableCell className="text-right">{f.count}</TableCell>
                    <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                      {f.detail ?? (f.samples[0] ? JSON.stringify(f.samples[0]) : '')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
