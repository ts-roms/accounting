'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { describeError } from '@/lib/api/client';
import {
  useDocuments,
  useParty,
  usePayments,
  useStatement,
  useUpdateParty,
} from '@/lib/api/subledger-hooks';
import { useSession } from '@/lib/auth/session';
import type { SubledgerConfig } from '@/lib/subledger/config';
import { titleCase } from '@/lib/format';
import { Can, ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { Amount, DateRange, startOfYear, today } from '@/components/accounting/primitives';
import { PartyDialog } from './parties';
import { DocumentStatusBadge, PaymentStatusBadge } from './badges';
import {
  CustomerCollectionsTab,
  CustomerCreditCard,
  CustomerMasterTab,
} from '@/components/receivables/ar-panels';
import { VendorMasterTab, VendorStatusCard } from '@/components/payables/ap-panels';
import { RecordLinksPanel } from '@/components/integrations/record-links-panel';

export function PartyDetailPage({ cfg, id }: { cfg: SubledgerConfig; id: string }) {
  const { hasPermission } = useSession();
  const party = useParty(cfg, id);
  const update = useUpdateParty(cfg);
  const documents = useDocuments(cfg, {
    partyId: id,
    pageSize: 50,
    sortBy: 'documentDate',
    sortDir: 'desc',
  });
  const payments = usePayments(cfg, {
    partyId: id,
    pageSize: 50,
    sortBy: 'paymentDate',
    sortDir: 'desc',
  });
  const [range, setRange] = React.useState({ from: startOfYear(), to: today() });
  const statement = useStatement(cfg, id, range);
  const [edit, setEdit] = React.useState(false);
  const [toggle, setToggle] = React.useState(false);

  if (party.isLoading || !party.data) return <Skeleton className="h-96" />;
  const p = party.data;
  const partyKey = cfg.side === 'AR' ? 'customerId' : 'vendorId';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {p.name}
            <Badge variant={p.status === 'ACTIVE' ? 'success' : 'secondary'}>{p.status}</Badge>
          </span>
        }
        description={`${p.code}${p.legalName && p.legalName !== p.name ? ` - ${p.legalName}` : ''}${p.taxIdentificationNumber ? ` - TIN ${p.taxIdentificationNumber}` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={cfg.party.path}>
                <ArrowLeft /> All {cfg.party.plural.toLowerCase()}
              </Link>
            </Button>
            <Can permissions={[cfg.permissions.docCreate]}>
              <Button variant="outline" size="sm" asChild>
                <Link href={`${cfg.document.path}/new?${partyKey}=${p.id}`}>
                  <Plus /> New {cfg.document.singular.toLowerCase()}
                </Link>
              </Button>
            </Can>
            <Can permissions={[cfg.permissions.payCreate]}>
              <Button variant="outline" size="sm" asChild>
                <Link href={`${cfg.payment.path}/new?${partyKey}=${p.id}`}>
                  <Plus /> New {cfg.payment.singular.toLowerCase()}
                </Link>
              </Button>
            </Can>
            {hasPermission(cfg.permissions.partyManage) ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setEdit(true)}>
                  <Pencil /> Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setToggle(true)}>
                  {p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Outstanding" value={p.balance.outstanding} />
        <Stat label="Overdue" value={p.balance.overdue} danger={p.balance.overdue !== '0.0000'} />
        <Stat label="Unapplied credit" value={p.balance.unappliedCredit} />
        <Stat
          label={cfg.side === 'AR' ? 'Net receivable' : 'Net payable'}
          value={p.balance.net}
          emphasis
        />
      </div>
      {cfg.side === 'AR' ? <CustomerCreditCard customer={p} /> : <VendorStatusCard vendor={p} />}
      <RecordLinksPanel
        entityType={cfg.side === 'AR' ? 'customers' : 'vendors'}
        internalId={p.id}
      />

      <Tabs defaultValue="documents">
        <TabsList>
          <TabsTrigger value="documents">{cfg.document.plural}</TabsTrigger>
          <TabsTrigger value="payments">{cfg.payment.plural}</TabsTrigger>
          <TabsTrigger value="statement">Statement</TabsTrigger>
          <TabsTrigger value="master">Profile & contacts</TabsTrigger>
          {cfg.side === 'AR' ? <TabsTrigger value="collections">Collections</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="master">
          {cfg.side === 'AR' ? <CustomerMasterTab customer={p} /> : <VendorMasterTab vendor={p} />}
        </TabsContent>
        {cfg.side === 'AR' ? (
          <TabsContent value="collections">
            <CustomerCollectionsTab customerId={p.id} />
          </TabsContent>
        ) : null}
        <TabsContent value="documents">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Date</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documents.data?.items.length ? (
                    documents.data.items.map((d) => (
                      <TableRow key={d.id}>
                        <TableCell className="whitespace-nowrap">{d.documentDate}</TableCell>
                        <TableCell>
                          <Link
                            href={`${cfg.document.path}/${d.id}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {d.documentNumber}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs">{titleCase(d.documentType)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {d.dueDate}
                          {d.daysOverdue > 0 ? (
                            <span className="ml-1 text-xs text-critical">+{d.daysOverdue}d</span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Amount value={d.total} />
                        </TableCell>
                        <TableCell>
                          <Amount value={d.balance} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <DocumentStatusBadge
                            status={d.status}
                            accountingStatus={d.accountingStatus}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        No {cfg.document.plural.toLowerCase()} yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="payments">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Date</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Unallocated</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.data?.items.length ? (
                    payments.data.items.map((pm) => (
                      <TableRow key={pm.id}>
                        <TableCell className="whitespace-nowrap">{pm.paymentDate}</TableCell>
                        <TableCell>
                          <Link
                            href={`${cfg.payment.path}/${pm.id}`}
                            className="font-mono text-xs hover:underline"
                          >
                            {pm.documentNumber}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs">
                          {pm.paymentType === 'PAYMENT' ? cfg.payment.singular : 'Refund'}
                        </TableCell>
                        <TableCell className="text-xs">{titleCase(pm.method)}</TableCell>
                        <TableCell>
                          <Amount value={pm.amount} />
                        </TableCell>
                        <TableCell>
                          <Amount value={pm.unallocatedAmount} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <PaymentStatusBadge status={pm.status} />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        No {cfg.payment.plural.toLowerCase()} yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="statement" className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-end justify-between space-y-0">
              <div>
                <CardTitle>Statement of account</CardTitle>
                <CardDescription>
                  Posted documents and {cfg.payment.plural.toLowerCase()} with a running balance.
                </CardDescription>
              </div>
              <DateRange from={range.from} to={range.to} onChange={setRange} />
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
                      <Amount value={statement.data?.openingBalance ?? '0'} />
                    </TableCell>
                  </TableRow>
                  {statement.data?.lines.map((l) => (
                    <TableRow key={`${l.kind}-${l.documentId}`}>
                      <TableCell className="whitespace-nowrap">{l.date}</TableCell>
                      <TableCell>
                        <Link
                          href={`${l.kind === 'PAYMENT' || l.kind === 'REFUND' ? cfg.payment.path : cfg.document.path}/${l.documentId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {l.documentNumber}
                        </Link>
                        <div className="text-[10px] uppercase text-muted-foreground">
                          {titleCase(l.kind)}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {l.description ?? l.reference ?? ''}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{l.dueDate ?? ''}</TableCell>
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
                      <Amount
                        value={statement.data?.closingBalance ?? '0'}
                        className="font-semibold"
                      />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <PartyDialog cfg={cfg} open={edit} party={p} onOpenChange={setEdit} />
      <ConfirmDialog
        open={toggle}
        onOpenChange={setToggle}
        title={`${p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${p.name}?`}
        description={
          p.status === 'ACTIVE'
            ? 'Inactive parties cannot receive new documents or payments. History is kept.'
            : 'The party will accept new documents again.'
        }
        confirmLabel={p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        destructive={p.status === 'ACTIVE'}
        loading={update.isPending}
        onConfirm={async () => {
          try {
            await update.mutateAsync({
              id: p.id,
              status: p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
            });
            toast.success(
              `${cfg.party.singular} ${p.status === 'ACTIVE' ? 'deactivated' : 'activated'}.`,
            );
            setToggle(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

function Stat({
  label,
  value,
  emphasis,
  danger,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  danger?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <Amount
          value={value}
          className={`${emphasis ? 'text-lg font-semibold' : 'text-lg'} ${danger ? 'text-critical' : ''}`}
        />
      </CardContent>
    </Card>
  );
}
