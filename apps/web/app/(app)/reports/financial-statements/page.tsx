'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';
import {
  Badge,
  Card,
  CardContent,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from '@accounting/ui';
import { useBalanceSheet, useIncomeStatement } from '@/lib/api/accounting-hooks';
import type { StatementSection } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';

export default function FinancialStatementsPage() {
  const { activeCompany } = useSession();
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const [asOf, setAsOf] = React.useState(today());
  const is = useIncomeStatement(
    { from: range.from, to: range.to },
    Boolean(range.from && range.to),
  );
  const bs = useBalanceSheet({ asOf }, Boolean(asOf));

  return (
    <>
      <PageHeader
        title="Financial Statements"
        description={`${activeCompany?.name ?? ''} - derived from posted journal entries. Click any line to drill into its ledger.`}
      />
      <Tabs defaultValue="income">
        <TabsList>
          <TabsTrigger value="income">Income Statement</TabsTrigger>
          <TabsTrigger value="balance">Balance Sheet</TabsTrigger>
        </TabsList>

        <TabsContent value="income" className="space-y-3">
          <Card>
            <CardContent className="p-4">
              <DateRange from={range.from} to={range.to} onChange={setRange} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              {is.isLoading || !is.data ? (
                <TableSkeleton columns={2} rows={10} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>
                        Income statement for {is.data.from} to {is.data.to}
                      </TableHead>
                      <TableHead className="w-44 text-right">{is.data.currency}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <Section section={is.data.revenue} currency={is.data.currency} />
                    <Section section={is.data.costOfSales} currency={is.data.currency} />
                    <TotalRow
                      label="Gross profit"
                      value={is.data.grossProfit}
                      currency={is.data.currency}
                    />
                    <Section section={is.data.expenses} currency={is.data.currency} />
                    <TotalRow
                      label="Net income"
                      value={is.data.netIncome}
                      currency={is.data.currency}
                      strong
                    />
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="balance" className="space-y-3">
          <Card>
            <CardContent className="flex flex-wrap items-end gap-4 p-4">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">As of</Label>
                <Input
                  type="date"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                  className="w-40"
                />
              </div>
              {bs.data ? (
                bs.data.balanced ? (
                  <Badge variant="success" className="mb-2">
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Assets = Liabilities + Equity
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="mb-2">
                    <XCircle className="mr-1 h-3 w-3" /> Out of balance
                  </Badge>
                )
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              {bs.isLoading || !bs.data ? (
                <TableSkeleton columns={2} rows={12} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Statement of financial position as of {bs.data.asOf}</TableHead>
                      <TableHead className="w-44 text-right">{bs.data.currency}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <Section section={bs.data.assets} currency={bs.data.currency} />
                    <TotalRow
                      label="Total assets"
                      value={bs.data.totalAssets}
                      currency={bs.data.currency}
                      strong
                    />
                    <Section section={bs.data.liabilities} currency={bs.data.currency} />
                    <Section section={bs.data.equity} currency={bs.data.currency} />
                    <TableRow>
                      <TableCell className="pl-8 italic text-muted-foreground">
                        Current earnings (not yet closed to retained earnings)
                      </TableCell>
                      <TableCell>
                        <Amount value={bs.data.currentEarnings} currency={bs.data.currency} />
                      </TableCell>
                    </TableRow>
                    <TotalRow
                      label="Total liabilities and equity"
                      value={bs.data.totalLiabilitiesAndEquity}
                      currency={bs.data.currency}
                      strong
                    />
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

function Section({ section, currency }: { section: StatementSection; currency: string }) {
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell className="text-xs font-semibold uppercase tracking-wide">
          {section.title}
        </TableCell>
        <TableCell />
      </TableRow>
      {section.rows.length === 0 ? (
        <TableRow>
          <TableCell className="pl-8 text-sm text-muted-foreground">No activity</TableCell>
          <TableCell />
        </TableRow>
      ) : (
        section.rows.map((r) => (
          <TableRow key={r.accountId}>
            <TableCell
              style={{ paddingLeft: `${16 + r.level * 16}px` }}
              className={cn(r.isHeader && 'font-medium')}
            >
              {r.isHeader ? (
                <span>
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{r.code}</span>
                  {r.name}
                </span>
              ) : (
                <Link
                  href={`/accounting/general-ledger?accountId=${r.accountId}&from=${r.drill.from ?? '2000-01-01'}&to=${r.drill.to}`}
                  className="hover:underline"
                >
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{r.code}</span>
                  {r.name}
                </Link>
              )}
            </TableCell>
            <TableCell>
              <Amount
                value={r.amount}
                currency={currency}
                className={cn(r.isHeader && 'font-medium')}
              />
            </TableCell>
          </TableRow>
        ))
      )}
      <TableRow className="hover:bg-transparent">
        <TableCell className="text-right text-xs text-muted-foreground">
          Total {section.title.toLowerCase()}
        </TableCell>
        <TableCell>
          <Amount value={section.total} currency={currency} className="font-medium" />
        </TableCell>
      </TableRow>
    </>
  );
}

function TotalRow({
  label,
  value,
  currency,
  strong,
}: {
  label: string;
  value: string;
  currency: string;
  strong?: boolean;
}) {
  return (
    <TableRow className={cn('hover:bg-transparent', strong && 'border-t-2 bg-muted/20')}>
      <TableCell className={cn('text-right', strong ? 'font-semibold' : 'font-medium')}>
        {label}
      </TableCell>
      <TableCell>
        <Amount
          value={value}
          currency={currency}
          className={strong ? 'text-base font-semibold' : 'font-medium'}
        />
      </TableCell>
    </TableRow>
  );
}
