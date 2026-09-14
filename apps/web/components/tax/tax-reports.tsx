'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { TAX_SIDES, type TaxSide } from '@accounting/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
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
import {
  useTaxCodes,
  useTaxSummary,
  useTaxTransactions,
  useWithholdingReport,
} from '@/lib/api/budgeting-tax-hooks';
import type { TaxTransaction } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';

const SOURCE_PATH: Record<TaxTransaction['sourceType'], string> = {
  AR_DOCUMENT: '/sales/invoices',
  AP_DOCUMENT: '/purchasing/bills',
  EXPENSE_CLAIM: '/budgeting/expense-claims',
};

export function TaxTransactionsPage() {
  const table = useTableState({ sortBy: 'transactionDate', sortDir: 'desc' });
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const [side, setSide] = React.useState('ALL');
  const [taxCodeId, setTaxCodeId] = React.useState('ALL');
  const codes = useTaxCodes(undefined, undefined);
  const txs = useTaxTransactions({
    ...table.query,
    from: range.from,
    to: range.to,
    side: side === 'ALL' ? undefined : (side as TaxSide),
    taxCodeId: taxCodeId === 'ALL' ? undefined : taxCodeId,
  });
  const columns = React.useMemo<ColumnDef<TaxTransaction>[]>(
    () => [
      {
        accessorKey: 'transactionDate',
        header: 'Date',
        cell: ({ row }) => (
          <span className="whitespace-nowrap">{row.original.transactionDate}</span>
        ),
      },
      {
        id: 'document',
        header: 'Document',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`${SOURCE_PATH[row.original.sourceType]}/${row.original.sourceId}`}
            className="font-mono text-xs hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.documentNumber}
          </Link>
        ),
      },
      {
        id: 'party',
        header: 'Counterparty',
        enableSorting: false,
        cell: ({ row }) =>
          row.original.partyName ?? <span className="text-muted-foreground">-</span>,
      },
      {
        id: 'code',
        header: 'Tax code',
        enableSorting: false,
        cell: ({ row }) => (
          <span>
            <span className="font-mono text-xs">{row.original.taxCode}</span>{' '}
            <span className="text-xs text-muted-foreground">
              {Number(row.original.ratePercent)}%
            </span>
          </span>
        ),
      },
      {
        id: 'side',
        header: 'Side',
        enableSorting: false,
        cell: ({ row }) => titleCase(row.original.side),
      },
      {
        id: 'base',
        header: () => <div className="text-right">Base</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.baseAmount} />,
      },
      {
        id: 'tax',
        header: () => <div className="text-right">Tax</div>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount
            value={row.original.taxAmount}
            className={row.original.reversalOfId ? 'text-muted-foreground' : undefined}
          />
        ),
      },
      {
        id: 'journal',
        header: 'Journal',
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`/accounting/journal-entries/${row.original.journalEntryId}`}
            className="font-mono text-xs hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.journalNumber}
          </Link>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Tax transactions"
        description="Every tax amount the engine posted, one row per document line and tax code. Reversals appear as negated rows pointing at the original."
      />
      <DataTable
        columns={columns}
        data={txs.data}
        isLoading={txs.isLoading}
        isFetching={txs.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(t) => t.id}
        toolbar={
          <>
            <DateRange
              from={range.from}
              to={range.to}
              onChange={(r) => {
                setRange(r);
                table.resetPage();
              }}
            />
            <Select
              value={side}
              onValueChange={(v) => {
                setSide(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Both sides</SelectItem>
                {TAX_SIDES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={taxCodeId}
              onValueChange={(v) => {
                setTaxCodeId(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All tax codes</SelectItem>
                {codes.data?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />
    </>
  );
}

export function TaxReportsPage() {
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const summary = useTaxSummary(range);
  const withholding = useWithholdingReport(range);
  const s = summary.data;
  return (
    <>
      <PageHeader
        title="Tax reports"
        description="Sums over posted tax transactions for the window: a VAT-style return (output less input) and withholding by counterparty for certificates."
        actions={<DateRange from={range.from} to={range.to} onChange={setRange} />}
      />
      {summary.isLoading || !s ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <Stat
              label="Output tax"
              value={
                <Amount value={s.totals.outputTax} currency={s.currency} className="text-left" />
              }
            />
            <Stat
              label="Input tax"
              value={
                <Amount value={s.totals.inputTax} currency={s.currency} className="text-left" />
              }
            />
            <Stat
              label="Net tax payable"
              value={
                <Amount
                  value={s.totals.netTaxPayable}
                  currency={s.currency}
                  className="text-left"
                />
              }
              hint="Output − input"
              danger={Number(s.totals.netTaxPayable) > 0}
            />
            <Stat
              label="Withholding receivable"
              value={
                <Amount
                  value={s.totals.withholdingReceivable}
                  currency={s.currency}
                  className="text-left"
                />
              }
              hint="Withheld by customers"
            />
            <Stat
              label="Withholding payable"
              value={
                <Amount
                  value={s.totals.withholdingPayable}
                  currency={s.currency}
                  className="text-left"
                />
              }
              hint="Withheld from vendors"
            />
          </div>
          <Tabs defaultValue="summary">
            <TabsList>
              <TabsTrigger value="summary">By tax code</TabsTrigger>
              <TabsTrigger value="withholding">Withholding by counterparty</TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              <Card>
                <CardHeader>
                  <CardTitle>Summary by tax code</CardTitle>
                  <CardDescription>
                    {s.from} → {s.to}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Code</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Lines</TableHead>
                        <TableHead className="text-right">Base</TableHead>
                        <TableHead className="text-right">Tax</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                            No tax transactions in this window.
                          </TableCell>
                        </TableRow>
                      ) : (
                        s.rows.map((r) => (
                          <TableRow key={`${r.taxCodeId}-${r.side}`} data-testid="tax-summary-row">
                            <TableCell>
                              <span className="font-mono text-xs">{r.code}</span> {r.name}
                            </TableCell>
                            <TableCell>
                              {r.kind === 'SALES_TAX' ? 'Sales tax' : 'Withholding'}
                            </TableCell>
                            <TableCell>{titleCase(r.side)}</TableCell>
                            <TableCell>{titleCase(r.reportingCategory)}</TableCell>
                            <TableCell className="text-right tabular">
                              {r.transactionCount}
                            </TableCell>
                            <TableCell>
                              <Amount value={r.baseAmount} currency={s.currency} />
                            </TableCell>
                            <TableCell>
                              <Amount value={r.taxAmount} currency={s.currency} />
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="withholding">
              <Card>
                <CardHeader>
                  <CardTitle>Withholding by counterparty</CardTitle>
                  <CardDescription>
                    Grouped by party, code and rate - the shape certificates and alphalists need.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Counterparty</TableHead>
                        <TableHead>Tax no.</TableHead>
                        <TableHead>Side</TableHead>
                        <TableHead>Code</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Base</TableHead>
                        <TableHead className="text-right">Withheld</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(withholding.data ?? []).length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                            No withholding in this window.
                          </TableCell>
                        </TableRow>
                      ) : (
                        withholding.data!.map((r, i) => (
                          <TableRow key={i}>
                            <TableCell>{r.partyName ?? '-'}</TableCell>
                            <TableCell className="font-mono text-xs">
                              {r.partyTaxNumber ?? '-'}
                            </TableCell>
                            <TableCell>{titleCase(r.side)}</TableCell>
                            <TableCell className="font-mono text-xs">{r.code}</TableCell>
                            <TableCell className="text-right tabular">
                              {Number(r.ratePercent)}%
                            </TableCell>
                            <TableCell>
                              <Amount value={r.baseAmount} currency={s.currency} />
                            </TableCell>
                            <TableCell>
                              <Amount value={r.taxAmount} currency={s.currency} />
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                    {(withholding.data ?? []).length > 0 ? (
                      <TableFooter>
                        <TableRow>
                          <TableCell colSpan={6}>Total withheld</TableCell>
                          <TableCell>
                            <Amount
                              value={withholding
                                .data!.reduce((sum, r) => sum + Number(r.taxAmount), 0)
                                .toFixed(4)}
                              currency={s.currency}
                              className="font-semibold"
                            />
                          </TableCell>
                        </TableRow>
                      </TableFooter>
                    ) : null}
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </>
  );
}
