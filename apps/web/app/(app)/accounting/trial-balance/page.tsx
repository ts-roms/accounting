'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  Checkbox,
  Label,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useTrialBalance } from '@/lib/api/accounting-hooks';
import { titleCase } from '@/lib/format';
import { PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';

export default function TrialBalancePage() {
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const [includeZero, setIncludeZero] = React.useState(false);
  const report = useTrialBalance(
    { from: range.from, to: range.to, includeZero },
    Boolean(range.from && range.to),
  );
  const data = report.data;

  return (
    <>
      <PageHeader
        title="Trial Balance"
        description="Opening balances, period movement and closing balances for every account. Debits must equal credits."
        actions={
          data ? (
            data.balanced ? (
              <Badge variant="success">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Balanced
              </Badge>
            ) : (
              <Badge variant="destructive">
                <XCircle className="mr-1 h-3 w-3" /> Out of balance
              </Badge>
            )
          ) : null
        }
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <DateRange from={range.from} to={range.to} onChange={setRange} />
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="include-zero"
              checked={includeZero}
              onCheckedChange={(v) => setIncludeZero(v === true)}
            />
            <Label htmlFor="include-zero" className="font-normal">
              Include accounts without activity
            </Label>
          </div>
        </CardContent>
      </Card>
      <div className="rounded-md border bg-card">
        {report.isLoading || !data ? (
          <TableSkeleton columns={8} rows={12} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead rowSpan={2} className="w-24 align-bottom">
                  Code
                </TableHead>
                <TableHead rowSpan={2} className="align-bottom">
                  Account
                </TableHead>
                <TableHead colSpan={2} className="border-b text-center">
                  Opening ({data.from})
                </TableHead>
                <TableHead colSpan={2} className="border-b text-center">
                  Movement
                </TableHead>
                <TableHead colSpan={2} className="border-b text-center">
                  Closing ({data.to})
                </TableHead>
              </TableRow>
              <TableRow className="hover:bg-transparent">
                {['Debit', 'Credit', 'Debit', 'Credit', 'Debit', 'Credit'].map((h, i) => (
                  <TableHead key={i} className="w-32 text-right">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((r) => (
                <TableRow key={r.accountId}>
                  <TableCell className="font-mono text-xs">{r.code}</TableCell>
                  <TableCell>
                    <Link
                      href={`/accounting/general-ledger?accountId=${r.accountId}&from=${data.from}&to=${data.to}`}
                      className="hover:underline"
                    >
                      {r.name}
                    </Link>
                    <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                      {titleCase(r.type)}
                    </span>
                  </TableCell>
                  {[
                    r.openingDebit,
                    r.openingCredit,
                    r.periodDebit,
                    r.periodCredit,
                    r.closingDebit,
                    r.closingCredit,
                  ].map((v, i) => (
                    <TableCell key={i}>
                      <Amount value={v} currency={data.currency} zeroAsDash />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {data.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No posted activity in this range.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={2}
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Totals ({data.currency})
                </TableCell>
                {[
                  data.totals.openingDebit,
                  data.totals.openingCredit,
                  data.totals.periodDebit,
                  data.totals.periodCredit,
                  data.totals.closingDebit,
                  data.totals.closingCredit,
                ].map((v, i) => (
                  <TableCell key={i}>
                    <Amount value={v} currency={data.currency} className="font-semibold" />
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </div>
    </>
  );
}
