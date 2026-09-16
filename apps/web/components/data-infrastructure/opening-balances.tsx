'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import { formatMoney } from '@accounting/money';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
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
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useLoadOpeningBalances,
  useOpeningBalanceReport,
} from '@/lib/api/data-infrastructure-hooks';
import { useParties } from '@/lib/api/subledger-hooks';
import { AP_CONFIG, AR_CONFIG } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { today } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';

const AREA_LABEL: Record<string, string> = {
  AR: 'Accounts receivable',
  AP: 'Accounts payable',
  INVENTORY: 'Inventory',
  FIXED_ASSETS: 'Fixed assets',
};

interface ItemRow {
  partyId: string;
  reference: string;
  documentDate: string;
  dueDate: string;
  amount: string;
}

/**
 * Controlled opening balances: the reconciliation report on top (control
 * account vs subledger per area, opening journals, equity residual) and the
 * loaders below. General-ledger balances come in through the Opening balances
 * CSV import or the journal screen; this page loads the subledgers.
 */
export function OpeningBalancesPage() {
  const [asOf, setAsOf] = React.useState(today());
  const report = useOpeningBalanceReport(asOf);
  const r = report.data;
  return (
    <>
      <PageHeader
        title="Opening balances"
        description="Load the cut-over position area by area - open receivables and payables, stock, migrated assets - each offset to the opening balance equity account, and prove that every control account equals its subledger."
        actions={
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="ob-asof">Cut-over date</Label>
              <Input
                id="ob-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                data-testid="ob-asof"
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
          <CardContent className="p-4 text-sm text-critical">
            {describeError(report.error)}
          </CardContent>
        </Card>
      ) : r ? (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Stat
              label="Status"
              value={
                <StatusBadge tone={r.reconciled ? 'positive' : 'warning'} data-testid="ob-status">
                  {r.reconciled ? 'Reconciled' : 'Not reconciled'}
                </StatusBadge>
              }
              hint={`as of ${r.asOf}`}
            />
            <Stat
              label="Opening journals"
              value={`${r.openingJournals.posted} posted`}
              hint={`${r.openingJournals.drafts} draft(s) · ${formatMoney(r.openingJournals.totalDebit, r.currency)}`}
            />
            <Stat
              label={`Opening equity (${r.openingEquity.code})`}
              value={
                <span className="tabular" data-testid="ob-equity">
                  {formatMoney(r.openingEquity.balance, r.currency)}
                </span>
              }
              hint="credit balance; nets to zero once equity itself is loaded"
            />
            <Stat
              label="Trial balance"
              value={r.trialBalanceBalanced ? 'Balanced' : 'Unbalanced'}
              danger={!r.trialBalanceBalanced}
            />
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Area</TableHead>
                    <TableHead className="text-right">Subledger</TableHead>
                    <TableHead className="text-right">Control account</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.areas.map((a) => (
                    <TableRow key={a.area} data-testid="ob-area" data-area={a.area}>
                      <TableCell className="font-medium">{AREA_LABEL[a.area]}</TableCell>
                      <TableCell className="text-right tabular">
                        {formatMoney(a.subledger, r.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        <Link
                          href={`/accounting/general-ledger?accountId=${a.controlAccountId}&to=${asOf}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {formatMoney(a.ledger, r.currency)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {formatMoney(a.variance, r.currency)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={a.reconciled ? 'positive' : 'critical'}>
                          {a.reconciled ? 'Reconciled' : 'Variance'}
                        </StatusBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
      <Can permissions={[P['opening-balance.manage']]}>
        <Loaders asOf={asOf} />
      </Can>
    </>
  );
}

function Loaders({ asOf }: { asOf: string }) {
  const load = useLoadOpeningBalances();
  const [area, setArea] = React.useState<'AR' | 'AP'>('AR');
  const [items, setItems] = React.useState<ItemRow[]>([blankItem(asOf)]);
  const parties =
    useParties(area === 'AR' ? AR_CONFIG : AP_CONFIG, { pageSize: 200 }).data?.items ?? [];
  const submit = async () => {
    const valid = items.filter((i) => i.partyId && i.reference && i.amount);
    if (valid.length === 0) return toast.error('Add at least one item.');
    try {
      const result = await load.mutateAsync({
        kind: 'subledger',
        body: {
          area,
          asOfDate: asOf,
          items: valid.map((i) => ({
            partyId: i.partyId,
            reference: i.reference,
            documentDate: i.documentDate,
            dueDate: i.dueDate || undefined,
            amount: i.amount,
          })),
        },
      });
      toast.success(`${result.created} ${area} item(s) loaded: ${formatMoney(result.total)}.`);
      setItems([blankItem(asOf)]);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Load open items</CardTitle>
        <CardDescription>
          One line per legacy open invoice or bill. Each is created, approved and posted against the
          opening balance equity account so the control account is backed by real documents. Opening
          stock and migrated assets are loaded through the API (`/opening-balances/inventory`,
          `/opening-balances/assets`) or the Opening balances import.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs value={area} onValueChange={(v) => setArea(v as 'AR' | 'AP')}>
          <TabsList>
            <TabsTrigger value="AR" data-testid="ob-tab-ar">
              Receivables
            </TabsTrigger>
            <TabsTrigger value="AP" data-testid="ob-tab-ap">
              Payables
            </TabsTrigger>
          </TabsList>
          <TabsContent value={area}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{area === 'AR' ? 'Customer' : 'Vendor'}</TableHead>
                  <TableHead>Legacy number</TableHead>
                  <TableHead>Document date</TableHead>
                  <TableHead>Due date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item, i) => (
                  <TableRow key={i} data-testid="ob-item">
                    <TableCell>
                      <Select
                        value={item.partyId}
                        onValueChange={(v) =>
                          setItems(items.map((x, j) => (j === i ? { ...x, partyId: v } : x)))
                        }
                      >
                        <SelectTrigger data-testid="ob-party">
                          <SelectValue placeholder="Choose" />
                        </SelectTrigger>
                        <SelectContent>
                          {parties.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.code} {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.reference}
                        onChange={(e) =>
                          setItems(
                            items.map((x, j) =>
                              j === i ? { ...x, reference: e.target.value } : x,
                            ),
                          )
                        }
                        data-testid="ob-reference"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        value={item.documentDate}
                        onChange={(e) =>
                          setItems(
                            items.map((x, j) =>
                              j === i ? { ...x, documentDate: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        value={item.dueDate}
                        onChange={(e) =>
                          setItems(
                            items.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        inputMode="decimal"
                        className="text-right tabular"
                        value={item.amount}
                        onChange={(e) =>
                          setItems(
                            items.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                          )
                        }
                        data-testid="ob-amount"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={items.length === 1}
                        onClick={() => setItems(items.filter((_, j) => j !== i))}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="mt-3 flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setItems([...items, blankItem(asOf)])}
              >
                <Plus /> Add item
              </Button>
              <Button loading={load.isPending} onClick={submit} data-testid="ob-load">
                <CheckCircle2 /> Load {titleCase(area === 'AR' ? 'receivables' : 'payables')}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function blankItem(asOf: string): ItemRow {
  return { partyId: '', reference: '', documentDate: asOf, dueDate: '', amount: '' };
}
