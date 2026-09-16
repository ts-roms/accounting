'use client';
import * as React from 'react';
import Link from 'next/link';
import { Plus, Truck } from 'lucide-react';
import { P } from '@accounting/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useDeliveries } from '@/lib/api/receivables-hooks';
import type { Order } from '@/lib/api/types';
import { Can } from '@/components/ui-ext/page';
import { NewDeliveryDialog } from './deliveries';
import { StatusBadge } from './shared';

interface CreditCheckSnapshot {
  checkedAt?: string;
  action?: string;
  outcome?: string | null;
  findings?: Array<{ rule: string; message: string; action: string }>;
  summary?: {
    creditLimit: string | null;
    creditUsed: string;
    availableCredit: string | null;
    status: string;
  };
}

/** Sales-order additions: recorded credit check, delivery progress and the deliveries raised from the order. */
export function SalesOrderArPanel({
  order,
}: {
  order: Order & { creditCheck?: CreditCheckSnapshot | null; deliveryStatus?: string };
}) {
  const deliveries = useDeliveries({ salesOrderId: order.id, pageSize: 50 });
  const [create, setCreate] = React.useState(false);
  const check = order.creditCheck;
  const open = order.status === 'APPROVED' || order.status === 'CONFIRMED';
  return (
    <>
      {check?.checkedAt ? (
        <Alert
          variant={
            check.outcome === 'REQUIRE_APPROVAL'
              ? 'warning'
              : check.outcome === 'WARN'
                ? 'default'
                : 'default'
          }
        >
          <AlertTitle>
            Credit check at {check.action}:{' '}
            {check.outcome ? check.outcome.replace('_', ' ').toLowerCase() : 'passed'}
            {check.summary
              ? ` - used ${check.summary.creditUsed}${check.summary.creditLimit ? ` of ${check.summary.creditLimit}` : ' (no limit)'}`
              : ''}
          </AlertTitle>
          {check.findings?.length ? (
            <AlertDescription>
              {check.findings.map((f) => (
                <div key={f.rule}>
                  <span className="font-medium">{f.rule}</span> (
                  {f.action.toLowerCase().replace('_', ' ')}): {f.message}
                </div>
              ))}
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Truck className="h-4 w-4" /> Deliveries{' '}
            {order.deliveryStatus ? (
              <StatusBadge
                status={
                  order.deliveryStatus === 'FULL'
                    ? 'DELIVERED'
                    : order.deliveryStatus === 'PARTIAL'
                      ? 'PICKING'
                      : 'DRAFT'
                }
              />
            ) : null}
          </CardTitle>
          {open ? (
            <Can permissions={[P['delivery.manage']]}>
              <Button size="sm" variant="outline" onClick={() => setCreate(true)}>
                <Plus /> Delivery
              </Button>
            </Can>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Invoices</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.data?.items.length ? (
                deliveries.data.items.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Link
                        href={`/receivables/deliveries/${d.id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {d.documentNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{d.deliveryDate}</TableCell>
                    <TableCell>{d.invoiceCount || '-'}</TableCell>
                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                    No deliveries yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <NewDeliveryDialog
        open={create}
        onOpenChange={setCreate}
        salesOrderId={order.id}
        onCreated={() => undefined}
      />
    </>
  );
}
