'use client';
import * as React from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useAssetRollforward } from '@/lib/api/lease-hooks';
import type { RollforwardGroup, RollforwardSide } from '@/lib/api/lease-types';
import { Amount, today } from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { QueryState } from '@/components/treasury/shared';

const startOfYear = () => `${today().slice(0, 4)}-01-01`;

const COLUMNS: Array<[keyof RollforwardSide, string]> = [
  ['opening', 'Opening'],
  ['additions', 'Additions'],
  ['depreciation', 'Depreciation'],
  ['impairment', 'Impairment'],
  ['revaluation', 'Revaluation'],
  ['disposals', 'Disposals'],
  ['closing', 'Closing'],
];

/** Fixed-asset note: cost and accumulated depreciation rolled forward per category, right-of-use assets as their own class. */
export function AssetRollforwardPage() {
  const [from, setFrom] = React.useState(startOfYear());
  const [to, setTo] = React.useState(today());
  const report = useAssetRollforward(from && to ? { from, to } : null);
  return (
    <>
      <PageHeader
        title="Asset Register Rollforward"
        description="Opening, movements and closing of cost and accumulated depreciation per category, replayed from the asset events - the fixed-asset note. Right-of-use assets from the lease register appear as their own class."
        actions={
          <div className="flex items-center gap-2">
            <Label className="text-xs">From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
            />
            <Label className="text-xs">To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
            />
          </div>
        }
      />
      <QueryState query={report}>
        {(r) => (
          <div className="space-y-4">
            {(['cost', 'accumulated'] as const).map((side) => (
              <Card key={side}>
                <CardHeader>
                  <CardTitle className="text-sm">
                    {side === 'cost' ? 'Cost' : 'Accumulated depreciation'}
                  </CardTitle>
                  <CardDescription>
                    {r.from} → {r.to} · {r.currency}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Category</TableHead>
                          {COLUMNS.map(([k, label]) => (
                            <TableHead key={k} className="text-right">
                              {label}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.groups.map((g) => (
                          <SideRow key={g.categoryCode} group={g} side={side} />
                        ))}
                      </TableBody>
                      <TableFooter>
                        <TableRow>
                          <TableCell>Total</TableCell>
                          {COLUMNS.map(([k]) => (
                            <TableCell key={k}>
                              <Amount value={r.totals[side][k]} zeroAsDash />
                            </TableCell>
                          ))}
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Book value and asset counts</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Opening book value</TableHead>
                      <TableHead className="text-right">Closing book value</TableHead>
                      <TableHead className="text-right">Assets opening</TableHead>
                      <TableHead className="text-right">Added</TableHead>
                      <TableHead className="text-right">Disposed</TableHead>
                      <TableHead className="text-right">Assets closing</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.groups.map((g) => (
                      <TableRow key={g.categoryCode} data-testid="rollforward-row">
                        <TableCell>
                          <span className="font-mono text-xs">{g.categoryCode}</span>{' '}
                          {g.categoryName}
                        </TableCell>
                        <TableCell>
                          <Amount value={g.bookValue.opening} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount value={g.bookValue.closing} zeroAsDash />
                        </TableCell>
                        <TableCell className="text-right tabular">{g.counts.opening}</TableCell>
                        <TableCell className="text-right tabular">{g.counts.additions}</TableCell>
                        <TableCell className="text-right tabular">{g.counts.disposals}</TableCell>
                        <TableCell className="text-right tabular">{g.counts.closing}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell>Total</TableCell>
                      <TableCell>
                        <Amount value={r.totals.bookValue.opening} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={r.totals.bookValue.closing} zeroAsDash />
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {r.totals.counts.opening}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {r.totals.counts.additions}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {r.totals.counts.disposals}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {r.totals.counts.closing}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </CardContent>
            </Card>
          </div>
        )}
      </QueryState>
    </>
  );
}

function SideRow({ group, side }: { group: RollforwardGroup; side: 'cost' | 'accumulated' }) {
  return (
    <TableRow data-testid={`rollforward-${side}-row`}>
      <TableCell>
        <span className="font-mono text-xs">{group.categoryCode}</span> {group.categoryName}
      </TableCell>
      {COLUMNS.map(([k]) => (
        <TableCell key={k}>
          <Amount value={group[side][k]} zeroAsDash />
        </TableCell>
      ))}
    </TableRow>
  );
}
