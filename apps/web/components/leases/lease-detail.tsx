'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useDeleteLease, useLease, useLeaseAction, type LeaseAction } from '@/lib/api/lease-hooks';
import type { LeaseDetail, LeaseLine } from '@/lib/api/lease-types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { BankAccountSelect } from '@/components/banking/shared';
import { ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { LeaseDialog } from './leases';
import {
  ClassificationBadge,
  Field,
  LEASES_PATH,
  LeaseStatusBadge,
  LineStatusBadge,
  Stat,
  frequencyLabel,
  timingLabel,
} from './shared';

const money = (v: string | null | undefined) =>
  Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ACTION_LABEL: Record<LeaseAction, string> = {
  commence: 'Commence',
  pay: 'Pay instalment',
  remeasure: 'Remeasure',
  terminate: 'Terminate',
};

export function LeaseDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { hasPermission } = useSession();
  const lease = useLease(id);
  const remove = useDeleteLease();
  const [action, setAction] = React.useState<{ action: LeaseAction; line?: LeaseLine } | null>(
    null,
  );
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  if (lease.isLoading || !lease.data) return <Skeleton className="h-96" />;
  const l = lease.data;
  const canManage = hasPermission(P['lease.manage']);
  const canPost = hasPermission(P['lease.post']);
  const finance = l.classification === 'FINANCE';
  const editable = l.status === 'DRAFT' || l.status === 'ACTIVE';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{l.leaseNumber}</span>
            <span>{l.name}</span>
            <LeaseStatusBadge status={l.status} />
            <ClassificationBadge classification={l.classification} />
          </span>
        }
        description={`${l.vendorName ?? 'No lessor'} · ${l.termMonths} months from ${l.commencementDate} · ${money(l.paymentAmount)} ${frequencyLabel(l.paymentFrequency)} ${timingLabel(l.paymentTiming)}${l.annualDiscountRate ? ` · ${Number(l.annualDiscountRate)}% p.a.` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={LEASES_PATH}>
                <ArrowLeft /> Leases
              </Link>
            </Button>
            {canManage && editable ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
            {canManage && l.status === 'DRAFT' ? (
              <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            ) : null}
            {canPost && l.status === 'DRAFT' ? (
              <Button
                size="sm"
                onClick={() => setAction({ action: 'commence' })}
                data-testid="lease-commence"
              >
                Commence
              </Button>
            ) : null}
            {canPost && l.status === 'ACTIVE' ? (
              <>
                {l.nextPayment ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      setAction({
                        action: 'pay',
                        line: l.lines.find((x) => x.id === l.nextPayment!.lineId),
                      })
                    }
                    data-testid="lease-pay"
                  >
                    Pay {l.nextPayment.date}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAction({ action: 'remeasure' })}
                >
                  Remeasure
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAction({ action: 'terminate' })}
                >
                  Terminate
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {l.status === 'TERMINATED' ? (
        <Alert>
          <AlertTitle>Terminated on {l.terminationDate}</AlertTitle>
          <AlertDescription>
            {Number(l.terminationGainLoss) < 0 ? 'Loss' : 'Gain'} on termination{' '}
            {money(String(Math.abs(Number(l.terminationGainLoss ?? 0))))}.
            {l.terminationJournalNumber ? (
              <>
                {' '}
                Journal <span className="font-mono">{l.terminationJournalNumber}</span>.
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {l.status === 'DRAFT' && l.preview ? (
        <Alert>
          <AlertTitle>Not yet commenced</AlertTitle>
          <AlertDescription>
            {finance
              ? `Commencing will recognize a liability of ${money(l.preview.initialLiability)} and a right-of-use asset of ${money(l.preview.rouCost)} over ${l.preview.lines.length} months.`
              : `Exempt lease: ${l.preview.lines.length} months of payments will be expensed as they are paid.`}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Lease liability"
          value={<Amount value={l.liabilityBalance} className="text-left" zeroAsDash />}
          hint={finance ? `Initially ${money(l.initialLiability)}` : 'Exempt - no liability'}
          testId="lease-liability"
        />
        <Stat
          label="Right-of-use carrying"
          value={<Amount value={l.rouCarrying} className="text-left" zeroAsDash />}
          hint={
            finance
              ? `Cost ${money(l.rouCost)} less ${money(l.rouAccumulatedDepreciation)}`
              : undefined
          }
        />
        <Stat
          label="Paid to date"
          value={<Amount value={l.paidTotal} className="text-left" zeroAsDash />}
          hint={`${money(l.remainingPayments)} still to pay`}
        />
        <Stat
          label="Next instalment"
          value={
            l.nextPayment ? <Amount value={l.nextPayment.amount} className="text-left" /> : '-'
          }
          hint={
            l.nextPayment
              ? `Due ${l.nextPayment.date} · ${l.remainingMonths} months to run`
              : undefined
          }
          danger={Boolean(l.nextPayment && l.nextPayment.date < today())}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
            <CardDescription>
              One line per month: interest accretes on the liability, the right-of-use asset
              depreciates straight-line, instalments fall on the payment dates.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[32rem] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Payment</TableHead>
                    <TableHead className="text-right">Interest</TableHead>
                    <TableHead className="text-right">Depreciation</TableHead>
                    <TableHead className="text-right">Closing liability</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Paid</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {l.lines.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                        The schedule is written at commencement.
                      </TableCell>
                    </TableRow>
                  ) : (
                    l.lines.map((line) => (
                      <TableRow
                        key={line.id}
                        data-testid="lease-line"
                        className={line.status === 'CANCELLED' ? 'opacity-50' : undefined}
                      >
                        <TableCell className="whitespace-nowrap text-xs">
                          <span className="font-medium">{line.sequence}</span>
                          <span className="ml-2 text-muted-foreground">
                            {line.periodStart} → {line.periodEnd}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Amount value={line.payment} zeroAsDash />
                          {line.paymentDate && Number(line.payment) ? (
                            <div className="text-right text-xs text-muted-foreground">
                              {line.paymentDate}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Amount value={line.interest} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount value={line.depreciation} zeroAsDash />
                        </TableCell>
                        <TableCell>
                          <Amount value={line.closingLiability} zeroAsDash />
                        </TableCell>
                        <TableCell className="text-xs">
                          {line.runNumber ? (
                            <Link
                              href={`/accounting/journal-entries/${line.journalEntryId}`}
                              className="font-mono hover:underline"
                            >
                              {line.runNumber}
                            </Link>
                          ) : (
                            <LineStatusBadge status={line.status} />
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {line.paymentJournalEntryId ? (
                            <Link
                              href={`/accounting/journal-entries/${line.paymentJournalEntryId}`}
                              className="font-mono hover:underline"
                            >
                              {line.paidDate}
                            </Link>
                          ) : Number(line.payment) && line.status !== 'CANCELLED' ? (
                            <span className="text-muted-foreground">unpaid</span>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-sm">
                <Field label="Lessor" value={l.vendorName ?? '-'} />
                <Field label="Ends" value={l.endDate} />
                <Field label="Pays from" value={l.bankAccountCode ?? '-'} />
                <Field label="Location" value={l.location ?? '-'} />
                <Field label="Reference" value={l.reference ?? '-'} />
                <Field
                  label="Initial direct costs"
                  value={<Amount value={l.initialDirectCosts} className="text-left" zeroAsDash />}
                />
                <Field
                  label="Incentives"
                  value={<Amount value={l.leaseIncentives} className="text-left" zeroAsDash />}
                />
                <Field
                  label="Commenced"
                  value={
                    l.commencementJournalEntryId ? (
                      <Link
                        href={`/accounting/journal-entries/${l.commencementJournalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {l.commencementJournalNumber}
                      </Link>
                    ) : l.commencedAt ? (
                      formatDateTime(l.commencedAt)
                    ) : (
                      '-'
                    )
                  }
                />
                <Field label="Created" value={formatDateTime(l.createdAt)} />
              </dl>
              {l.description ? (
                <p className="mt-3 text-sm text-muted-foreground">{l.description}</p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>
                Every change to the carrying amounts and its journal.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  {l.events.length === 0 ? (
                    <TableRow>
                      <TableCell className="py-6 text-center text-muted-foreground">
                        Not yet commenced.
                      </TableCell>
                    </TableRow>
                  ) : (
                    l.events.map((e) => (
                      <TableRow key={e.id} data-testid="lease-event">
                        <TableCell className="whitespace-nowrap text-xs">{e.eventDate}</TableCell>
                        <TableCell>
                          <div className="text-sm font-medium">{titleCase(e.eventType)}</div>
                          {e.notes ? (
                            <div className="text-xs text-muted-foreground">{e.notes}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs">
                          {e.journalEntryId ? (
                            <Link
                              href={`/accounting/journal-entries/${e.journalEntryId}`}
                              className="font-mono hover:underline"
                            >
                              {e.journalNumber}
                            </Link>
                          ) : (
                            '-'
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
      <LeaseDialog open={editing} lease={l} onOpenChange={setEditing} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${l.leaseNumber}?`}
        description="Drafts have no ledger effect and can be removed."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(l.id);
            toast.success('Lease deleted.');
            router.push(LEASES_PATH);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <LeaseActionDialog
        lease={l}
        action={action?.action ?? null}
        line={action?.line}
        onOpenChange={(o) => !o && setAction(null)}
      />
    </>
  );
}

/** One dialog for the lifecycle actions; fields depend on the action. */
function LeaseActionDialog({
  lease,
  action,
  line,
  onOpenChange,
}: {
  lease: LeaseDetail;
  action: LeaseAction | null;
  line?: LeaseLine;
  onOpenChange: (open: boolean) => void;
}) {
  const run = useLeaseAction();
  const [date, setDate] = React.useState(today());
  const [bankAccountId, setBankAccountId] = React.useState<string | null>(null);
  const [clearingAccountId, setClearingAccountId] = React.useState<string | null>(null);
  const [termMonths, setTermMonths] = React.useState('');
  const [paymentAmount, setPaymentAmount] = React.useState('');
  const [rate, setRate] = React.useState('');
  const [notes, setNotes] = React.useState('');
  React.useEffect(() => {
    if (!action) return;
    setDate(
      action === 'commence'
        ? lease.commencementDate
        : action === 'pay'
          ? (line?.paymentDate ?? today())
          : action === 'remeasure'
            ? (lease.lines.find((x) => x.status === 'PENDING')?.periodStart ?? today())
            : today(),
    );
    setBankAccountId(lease.bankAccountId);
    setClearingAccountId(null);
    setTermMonths('');
    setPaymentAmount('');
    setRate('');
    setNotes('');
  }, [action, lease, line]);
  if (!action) return null;
  const text = (v: string) => (v.trim() ? v.trim() : undefined);
  const hasIdc = Number(lease.initialDirectCosts) || Number(lease.leaseIncentives);

  const submit = async () => {
    try {
      const input =
        action === 'commence'
          ? {
              action,
              input: { postingDate: date, clearingAccountId: clearingAccountId ?? undefined },
            }
          : action === 'pay'
            ? {
                action,
                input: {
                  lineId: line!.id,
                  bankAccountId: bankAccountId!,
                  paymentDate: date,
                  memo: text(notes),
                },
              }
            : action === 'remeasure'
              ? {
                  action,
                  input: {
                    effectiveDate: date,
                    termMonths: termMonths ? Number(termMonths) : undefined,
                    paymentAmount: text(paymentAmount),
                    annualDiscountRate: text(rate),
                    notes: text(notes),
                  },
                }
              : { action, input: { terminationDate: date, notes: text(notes) } };
      const result = await run.mutateAsync({ id: lease.id, ...input });
      toast.success(`${lease.leaseNumber} ${titleCase(result.status).toLowerCase()}.`);
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {ACTION_LABEL[action]} {lease.leaseNumber}
          </DialogTitle>
          <DialogDescription>
            {action === 'commence'
              ? lease.classification === 'FINANCE'
                ? 'Posts Dr right-of-use asset / Cr lease liability at the present value of the payments and writes the schedule.'
                : 'Exempt lease: writes the payment schedule; each instalment is expensed when paid.'
              : action === 'pay'
                ? lease.classification === 'FINANCE'
                  ? `Month ${line?.sequence}: Dr lease liability / Cr bank.`
                  : `Month ${line?.sequence}: Dr lease expense / Cr bank.`
                : action === 'remeasure'
                  ? 'Re-discounts the remaining payments from the effective month; the change adjusts the right-of-use asset and the liability.'
                  : 'Derecognizes the right-of-use asset and the remaining liability; the difference is a gain or loss.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>
              {action === 'commence'
                ? 'Posting date'
                : action === 'pay'
                  ? 'Payment date'
                  : action === 'remeasure'
                    ? 'Effective date (start of a schedule month)'
                    : 'Termination date'}
            </Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {action === 'commence' && hasIdc ? (
            <div className="space-y-1">
              <Label>Clearing account for initial direct costs / incentives</Label>
              <AccountCombobox
                value={clearingAccountId}
                onChange={(id) => setClearingAccountId(id)}
                placeholder="Fixed asset clearing (default)"
                types={['ASSET', 'LIABILITY']}
              />
            </div>
          ) : null}
          {action === 'pay' ? (
            <>
              <div className="space-y-1">
                <Label>Amount</Label>
                <Input value={line?.payment ?? ''} disabled className="text-right tabular" />
              </div>
              <div className="space-y-1">
                <Label>Bank account</Label>
                <BankAccountSelect
                  value={bankAccountId}
                  onChange={setBankAccountId}
                  testId="pay-bank"
                />
              </div>
            </>
          ) : null}
          {action === 'remeasure' ? (
            <>
              <div className="space-y-1">
                <Label>New total term (months)</Label>
                <Input
                  inputMode="numeric"
                  placeholder={String(lease.termMonths)}
                  value={termMonths}
                  onChange={(e) => setTermMonths(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>New payment per period</Label>
                <Input
                  inputMode="decimal"
                  className="text-right tabular"
                  placeholder={lease.paymentAmount}
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>New annual rate %</Label>
                <Input
                  inputMode="decimal"
                  placeholder={lease.annualDiscountRate ?? ''}
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </div>
            </>
          ) : null}
          {action !== 'commence' ? (
            <div className="space-y-1">
              <Label>{action === 'pay' ? 'Memo' : 'Notes'}</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={run.isPending || (action === 'pay' && !bankAccountId)}
            data-testid="lease-action-confirm"
          >
            {ACTION_LABEL[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
