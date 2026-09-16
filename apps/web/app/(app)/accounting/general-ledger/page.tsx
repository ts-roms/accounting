'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useGeneralLedger } from '@/lib/api/accounting-hooks';
import { titleCase } from '@/lib/format';
import { EmptyState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { ExportButton } from '@/components/data-infrastructure/export-button';
import {
  AccountCombobox,
  Amount,
  DateRange,
  JournalStatusBadge,
  startOfYear,
  today,
} from '@/components/accounting/primitives';

export default function GeneralLedgerPage() {
  return (
    <React.Suspense fallback={null}>
      <GeneralLedgerContent />
    </React.Suspense>
  );
}

function GeneralLedgerContent() {
  const params = useSearchParams();
  const router = useRouter();
  const [accountId, setAccountId] = React.useState<string | null>(params.get('accountId'));
  const [range, setRange] = React.useState({
    from: params.get('from') ?? startOfYear(),
    to: params.get('to') ?? today(),
  });
  const [page, setPage] = React.useState(1);
  const pageSize = 100;

  React.useEffect(() => {
    const p = new URLSearchParams();
    if (accountId) p.set('accountId', accountId);
    p.set('from', range.from);
    p.set('to', range.to);
    router.replace(`/accounting/general-ledger?${p.toString()}`);
  }, [accountId, range, router]);

  const ledger = useGeneralLedger(
    { accountId: accountId ?? undefined, from: range.from, to: range.to, page, pageSize },
    Boolean(accountId && range.from && range.to),
  );
  const data = ledger.data;

  return (
    <>
      <PageHeader
        title="General Ledger"
        description="Posted lines per account with opening, running and closing balances. Balances are signed by the account's normal side."
        actions={
          accountId ? (
            <ExportButton
              dataset="GENERAL_LEDGER"
              query={{ accountId, from: range.from, to: range.to }}
            />
          ) : null
        }
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="w-[420px] space-y-1">
            <span className="text-xs text-muted-foreground">Account</span>
            <AccountCombobox
              value={accountId}
              onChange={(id) => {
                setAccountId(id);
                setPage(1);
              }}
            />
          </div>
          <DateRange
            from={range.from}
            to={range.to}
            onChange={(r) => {
              setRange(r);
              setPage(1);
            }}
          />
        </CardContent>
      </Card>

      {!accountId ? (
        <EmptyState
          title="Select an account"
          description="Choose a postable account and a date range to view its ledger."
        />
      ) : ledger.isLoading ? (
        <TableSkeleton columns={7} />
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Opening balance" value={data.openingBalance} currency={data.currency} />
            <Stat label="Period debits" value={data.periodDebit} currency={data.currency} />
            <Stat label="Period credits" value={data.periodCredit} currency={data.currency} />
            <Stat
              label="Closing balance"
              value={data.closingBalance}
              currency={data.currency}
              emphasis
            />
          </div>
          <div className="rounded-md border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2 text-sm">
              <div>
                <span className="font-mono text-xs text-muted-foreground">{data.account.code}</span>{' '}
                <span className="font-medium">{data.account.name}</span>{' '}
                <Badge variant="outline" className="ml-2">
                  {titleCase(data.account.type)} -{' '}
                  {data.account.normalBalance === 'DEBIT' ? 'Dr' : 'Cr'} normal
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">
                {data.total} lines - {data.from} to {data.to}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-28">Date</TableHead>
                  <TableHead className="w-36">Entry</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                  <TableHead className="w-36 text-right">Debit</TableHead>
                  <TableHead className="w-36 text-right">Credit</TableHead>
                  <TableHead className="w-40 text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell
                    colSpan={6}
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Opening balance
                  </TableCell>
                  <TableCell>
                    <Amount value={data.openingBalance} currency={data.currency} />
                  </TableCell>
                </TableRow>
                {data.lines.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      No posted activity in this range.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.lines.map((l, i) => (
                    <TableRow key={`${l.journalEntryId}-${i}`}>
                      <TableCell className="whitespace-nowrap">{l.entryDate}</TableCell>
                      <TableCell>
                        <Link
                          href={`/accounting/journal-entries/${l.journalEntryId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {l.documentNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="max-w-md truncate">
                          {l.lineDescription ?? l.entryDescription}
                        </div>
                        {l.reference ? (
                          <div className="text-xs text-muted-foreground">Ref: {l.reference}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <JournalStatusBadge status={l.status} />
                      </TableCell>
                      <TableCell>
                        <Amount value={l.debit} currency={data.currency} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={l.credit} currency={data.currency} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={l.balance} currency={data.currency} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={4}
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Closing balance
                  </TableCell>
                  <TableCell>
                    <Amount
                      value={data.periodDebit}
                      currency={data.currency}
                      className="font-semibold"
                    />
                  </TableCell>
                  <TableCell>
                    <Amount
                      value={data.periodCredit}
                      currency={data.currency}
                      className="font-semibold"
                    />
                  </TableCell>
                  <TableCell>
                    <Amount
                      value={data.closingBalance}
                      currency={data.currency}
                      className="font-semibold"
                    />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
            {data.total > pageSize ? (
              <div className="flex items-center justify-end gap-2 border-t px-4 py-2 text-sm text-muted-foreground">
                Page {page} of {Math.ceil(data.total / pageSize)}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page * pageSize >= data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}

function Stat({
  label,
  value,
  currency,
  emphasis,
}: {
  label: string;
  value: string;
  currency: string;
  emphasis?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <Amount
          value={value}
          currency={currency}
          className={emphasis ? 'text-lg font-semibold' : 'text-lg'}
        />
      </CardContent>
    </Card>
  );
}
