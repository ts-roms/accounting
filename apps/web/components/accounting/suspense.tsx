'use client';
import * as React from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { P, type SuspenseStatus } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useSuspenseMonitor } from '@/lib/api/accounting-core-hooks';
import { useSession } from '@/lib/auth/session';
import { EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';

const STATUS_VARIANT: Record<SuspenseStatus, 'success' | 'secondary' | 'warning'> = {
  CLEAR: 'success',
  WITHIN_POLICY: 'secondary',
  REQUIRES_INVESTIGATION: 'warning',
};

/**
 * Suspense / clearing account monitor: what is parked in each account, since
 * when, who owns it and whether the company policy (materiality, max age)
 * requires investigation. Clearing is a reclassification journal.
 */
export function SuspensePage() {
  const { hasPermission } = useSession();
  const [asOf, setAsOf] = React.useState(today());
  const report = useSuspenseMonitor(asOf);
  const r = report.data;
  const open = r?.accounts.reduce((n, a) => n + a.openTransactions, 0) ?? 0;
  const oldest = r?.accounts.reduce((n, a) => Math.max(n, a.ageDays), 0) ?? 0;
  return (
    <>
      <PageHeader
        title="Suspense accounts"
        description="Suspense and clearing accounts are expected to return to zero. The monitor shows the postings not yet explained, their age, the owner and whether the company policy requires investigation. Clear a balance with a reclassification journal - never by editing history."
        actions={
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="suspense-asof">As of</Label>
              <Input
                id="suspense-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                data-testid="suspense-asof"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void report.refetch()}
              disabled={report.isFetching}
            >
              <RefreshCw className={report.isFetching ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        }
      />
      {report.isError ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            {describeError(report.error)}
          </CardContent>
        </Card>
      ) : !r ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-4" data-testid="suspense-stats">
            <Stat
              label="Suspense balance (absolute)"
              value={<Amount value={r.totalBalance} currency={r.currency} className="inline" />}
              hint={`Materiality ${r.materiality} · max age ${r.maxAgeDays} days`}
              danger={r.totalBalance !== '0.0000'}
            />
            <Stat
              label="Requires investigation"
              value={<span data-testid="suspense-flagged">{r.requiresInvestigation}</span>}
              danger={r.requiresInvestigation > 0}
            />
            <Stat label="Open postings" value={open} danger={open > 0} />
            <Stat label="Oldest item" value={`${oldest} days`} danger={oldest > r.maxAgeDays} />
          </div>
          {r.accounts.length === 0 ? (
            <EmptyState
              title="No suspense accounts"
              description="Give an account the SUSPENSE subtype (or map SUSPENSE / FIXED_ASSET_CLEARING / GOODS_RECEIVED_NOT_INVOICED) to monitor it here."
            />
          ) : (
            r.accounts.map((a) => (
              <Card key={a.accountId} data-testid="suspense-account" data-code={a.code}>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="font-mono text-xs text-muted-foreground">{a.code}</span>
                    {a.name}
                    <Badge variant={STATUS_VARIANT[a.status]} data-testid="suspense-status">
                      {a.status}
                    </Badge>
                    {a.openTransactions > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {a.openTransactions} open · {a.ageDays}d
                      </span>
                    ) : null}
                  </CardTitle>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground">
                      Owner: {a.ownerName ?? a.ownerEmail ?? 'unassigned'}
                    </span>
                    <Amount value={a.balance} currency={r.currency} className="font-semibold" />
                    <Button variant="outline" size="sm" asChild>
                      <Link
                        href={`/accounting/general-ledger?accountId=${a.accountId}&from=2000-01-01&to=${asOf}`}
                      >
                        Ledger
                      </Link>
                    </Button>
                    {hasPermission(P['journal.create']) && a.openTransactions > 0 ? (
                      <Button size="sm" asChild>
                        <Link
                          href={`/accounting/journal-entries/new?journalType=RECLASSIFICATION&accountId=${a.accountId}&description=${encodeURIComponent(`Clear suspense ${a.code}`)}`}
                        >
                          Clear
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                {a.reasons.length > 0 ? (
                  <CardContent className="pt-0 text-xs text-muted-foreground">
                    {a.reasons.join(' · ')}
                  </CardContent>
                ) : null}
                {a.lines.length > 0 ? (
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Date</TableHead>
                          <TableHead>Journal</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead className="text-right">Debit</TableHead>
                          <TableHead className="text-right">Credit</TableHead>
                          <TableHead className="text-right">Age</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {a.lines.map((l, i) => (
                          <TableRow key={`${l.journalEntryId}-${i}`}>
                            <TableCell>{l.entryDate}</TableCell>
                            <TableCell>
                              <Link
                                href={`/accounting/journal-entries/${l.journalEntryId}`}
                                className="font-mono text-xs hover:underline"
                              >
                                {l.documentNumber}
                              </Link>
                            </TableCell>
                            <TableCell className="text-muted-foreground">{l.description}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {l.sourceType ?? 'Manual'}
                            </TableCell>
                            <TableCell>
                              <Amount value={l.debit} currency={r.currency} zeroAsDash />
                            </TableCell>
                            <TableCell>
                              <Amount value={l.credit} currency={r.currency} zeroAsDash />
                            </TableCell>
                            <TableCell className="text-right text-xs">{l.ageDays}d</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                ) : null}
              </Card>
            ))
          )}
        </>
      )}
    </>
  );
}
