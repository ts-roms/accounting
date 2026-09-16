'use client';
import * as React from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useVendorStatement } from '@/lib/api/payables-hooks';
import { AP_CONFIG } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';

export function VendorStatementsPage() {
  const [vendorId, setVendorId] = React.useState<string | null>(null);
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const statement = useVendorStatement({ vendorId, from: range.from, to: range.to });
  const report = statement.data;
  return (
    <>
      <PageHeader
        title="Vendor Statements"
        description="Opening balance, bills, vendor credits, payments, refunds, discounts taken and the running balance for a period - what the vendor should see."
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="w-72 space-y-1.5">
            <Label>Vendor</Label>
            <PartyCombobox cfg={AP_CONFIG} value={vendorId} onChange={(id) => setVendorId(id)} />
          </div>
          <DateRange from={range.from} to={range.to} onChange={setRange} />
        </CardContent>
      </Card>
      {vendorId && statement.isLoading ? <Skeleton className="h-64" /> : null}
      {report ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {report.party.name} - {report.from} to {report.to}
            </CardTitle>
            <CardDescription>
              {report.party.code}
              {report.party.email ? ` - ${report.party.email}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
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
                    <Amount value={report.openingBalance} />
                  </TableCell>
                </TableRow>
                {report.lines.map((l) => (
                  <TableRow key={`${l.kind}-${l.documentId}-${l.date}`}>
                    <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{l.documentNumber}</span>
                      <div className="text-[10px] uppercase text-muted-foreground">
                        {titleCase(l.kind)}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {l.description ?? l.reference ?? ''}
                    </TableCell>
                    <TableCell className="text-xs">{l.dueDate ?? ''}</TableCell>
                    <TableCell>
                      <Amount value={l.debit} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.credit} zeroAsDash />
                    </TableCell>
                    <TableCell>
                      <Amount value={l.balance} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={6}
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    Closing balance
                  </TableCell>
                  <TableCell>
                    <Amount value={report.closingBalance} className="font-semibold" />
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
