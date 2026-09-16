'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
import { useCashFlow } from '@/lib/api/accounting-core-hooks';
import type { CashFlowSection, StatementSection } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';

export default function FinancialStatementsPage() {
  const { activeCompany } = useSession();
  const initialTab = useSearchParams().get('tab');
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const [asOf, setAsOf] = React.useState(today());
  const [compare, setCompare] = React.useState(false);
  const priorYear = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
  const is = useIncomeStatement(
    {
      from: range.from,
      to: range.to,
      ...(compare ? { compareFrom: priorYear(range.from), compareTo: priorYear(range.to) } : {}),
    },
    Boolean(range.from && range.to),
  );
  const bs = useBalanceSheet({ asOf }, Boolean(asOf));
  const cf = useCashFlow({ from: range.from, to: range.to }, Boolean(range.from && range.to));
  const comparative = is.data?.comparative;

  return (
    <>
      <PageHeader
        title="Financial Statements"
        description={`${activeCompany?.name ?? ''} - derived from posted journal entries. Click any line to drill into its ledger.`}
      />
      <Tabs
        defaultValue={initialTab === 'cashflow' || initialTab === 'balance' ? initialTab : 'income'}
      >
        <TabsList>
          <TabsTrigger value="income">Income Statement</TabsTrigger>
          <TabsTrigger value="balance">Balance Sheet</TabsTrigger>
          <TabsTrigger value="cashflow">Cash Flow</TabsTrigger>
        </TabsList>

        <TabsContent value="income" className="space-y-3">
          <Card>
            <CardContent className="flex flex-wrap items-end gap-4 p-4">
              <DateRange from={range.from} to={range.to} onChange={setRange} />
              <label className="mb-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={compare}
                  onChange={(e) => setCompare(e.target.checked)}
                  data-testid="pl-compare"
                />
                Compare with the same period last year
              </label>
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
                      {comparative ? (
                        <TableHead className="w-44 text-right text-muted-foreground">
                          {comparative.from} to {comparative.to}
                        </TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <Section
                      section={is.data.revenue}
                      currency={is.data.currency}
                      compare={comparative?.revenue}
                    />
                    <Section
                      section={is.data.costOfSales}
                      currency={is.data.currency}
                      compare={comparative?.costOfSales}
                    />
                    <TotalRow
                      label="Gross profit"
                      value={is.data.grossProfit}
                      compare={comparative?.grossProfit}
                      currency={is.data.currency}
                    />
                    <Section
                      section={is.data.expenses}
                      currency={is.data.currency}
                      compare={comparative?.expenses}
                    />
                    <TotalRow
                      label="Operating income"
                      value={is.data.operatingIncome}
                      compare={comparative?.operatingIncome}
                      currency={is.data.currency}
                    />
                    <Section
                      section={is.data.otherIncome}
                      currency={is.data.currency}
                      compare={comparative?.otherIncome}
                    />
                    <Section
                      section={is.data.otherExpenses}
                      currency={is.data.currency}
                      compare={comparative?.otherExpenses}
                    />
                    <TotalRow
                      label="Net income"
                      value={is.data.netIncome}
                      compare={comparative?.netIncome}
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

        <TabsContent value="cashflow" className="space-y-3">
          <Card>
            <CardContent className="flex flex-wrap items-end gap-4 p-4">
              <DateRange from={range.from} to={range.to} onChange={setRange} />
              {cf.data ? (
                cf.data.balanced ? (
                  <Badge variant="success" className="mb-2" data-testid="cashflow-balanced">
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Reconciles to the cash accounts
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="mb-2">
                    <XCircle className="mr-1 h-3 w-3" /> Does not reconcile
                  </Badge>
                )
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              {cf.isLoading || !cf.data ? (
                <TableSkeleton columns={2} rows={12} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>
                        Cash-flow statement ({cf.data.method.toLowerCase()} method) for{' '}
                        {cf.data.from} to {cf.data.to}
                      </TableHead>
                      <TableHead className="w-44 text-right">{cf.data.currency}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell className="text-xs font-semibold uppercase tracking-wide">
                        Operating activities
                      </TableCell>
                      <TableCell />
                    </TableRow>
                    <TableRow>
                      <TableCell className="pl-8">Net income</TableCell>
                      <TableCell>
                        <Amount value={cf.data.netIncome} currency={cf.data.currency} />
                      </TableCell>
                    </TableRow>
                    <CashSection
                      section={cf.data.operating}
                      currency={cf.data.currency}
                      hideTitle
                    />
                    <CashSection section={cf.data.investing} currency={cf.data.currency} />
                    <CashSection section={cf.data.financing} currency={cf.data.currency} />
                    <TotalRow
                      label="Net change in cash"
                      value={cf.data.netChangeInCash}
                      currency={cf.data.currency}
                      strong
                    />
                    <TableRow>
                      <TableCell className="text-right text-muted-foreground">
                        Opening cash
                      </TableCell>
                      <TableCell>
                        <Amount value={cf.data.openingCash} currency={cf.data.currency} />
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="text-right text-muted-foreground">
                        Closing cash
                      </TableCell>
                      <TableCell>
                        <Amount
                          value={cf.data.closingCash}
                          currency={cf.data.currency}
                          className="font-medium"
                        />
                      </TableCell>
                    </TableRow>
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

function CashSection({
  section,
  currency,
  hideTitle,
}: {
  section: CashFlowSection;
  currency: string;
  hideTitle?: boolean;
}) {
  return (
    <>
      {hideTitle ? null : (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell className="text-xs font-semibold uppercase tracking-wide">
            {section.title}
          </TableCell>
          <TableCell />
        </TableRow>
      )}
      {section.lines.map((l) => (
        <TableRow key={l.accountId}>
          <TableCell className="pl-8">
            <Link
              href={`/accounting/general-ledger?accountId=${l.accountId}&from=${l.drill.from}&to=${l.drill.to}`}
              className="hover:underline"
            >
              <span className="mr-2 font-mono text-xs text-muted-foreground">{l.code}</span>
              {l.name}
            </Link>
          </TableCell>
          <TableCell>
            <Amount value={l.amount} currency={currency} />
          </TableCell>
        </TableRow>
      ))}
      <TableRow className="hover:bg-transparent">
        <TableCell className="text-right text-xs text-muted-foreground">
          Net cash from {section.title.toLowerCase()}
        </TableCell>
        <TableCell>
          <Amount value={section.total} currency={currency} className="font-medium" />
        </TableCell>
      </TableRow>
    </>
  );
}

function Section({
  section,
  currency,
  compare,
}: {
  section: StatementSection;
  currency: string;
  compare?: StatementSection;
}) {
  const compareBy = new Map((compare?.rows ?? []).map((r) => [r.accountId, r.amount]));
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell className="text-xs font-semibold uppercase tracking-wide">
          {section.title}
        </TableCell>
        <TableCell />
        {compare ? <TableCell /> : null}
      </TableRow>
      {section.rows.length === 0 ? (
        <TableRow>
          <TableCell className="pl-8 text-sm text-muted-foreground">No activity</TableCell>
          <TableCell />
          {compare ? <TableCell /> : null}
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
            {compare ? (
              <TableCell>
                <Amount
                  value={compareBy.get(r.accountId) ?? '0'}
                  currency={currency}
                  className="text-muted-foreground"
                />
              </TableCell>
            ) : null}
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
        {compare ? (
          <TableCell>
            <Amount value={compare.total} currency={currency} className="text-muted-foreground" />
          </TableCell>
        ) : null}
      </TableRow>
    </>
  );
}

function TotalRow({
  label,
  value,
  currency,
  strong,
  compare,
}: {
  label: string;
  value: string;
  currency: string;
  strong?: boolean;
  compare?: string;
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
      {compare !== undefined ? (
        <TableCell>
          <Amount value={compare} currency={currency} className="text-muted-foreground" />
        </TableCell>
      ) : null}
    </TableRow>
  );
}
