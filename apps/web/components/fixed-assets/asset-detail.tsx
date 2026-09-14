'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Money } from '@accounting/money';
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
import {
  useAssetAction,
  useDeleteFixedAsset,
  useFixedAsset,
  type AssetAction,
} from '@/lib/api/assets-banking-hooks';
import type { FixedAssetDetail } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { ConfirmDialog, PageHeader } from '@/components/ui-ext/page';
import { AccountCombobox, Amount, today } from '@/components/accounting/primitives';
import { AssetDialog } from './assets';
import { ASSETS_PATH, AssetStatusBadge, Field, Stat, methodLabel } from './shared';

const ACTION_LABEL: Record<AssetAction, string> = {
  capitalize: 'Capitalise',
  transfer: 'Transfer',
  impair: 'Impair',
  revalue: 'Revalue',
  dispose: 'Dispose / write off',
};

export function FixedAssetDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { hasPermission } = useSession();
  const asset = useFixedAsset(id);
  const remove = useDeleteFixedAsset();
  const [action, setAction] = React.useState<AssetAction | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  if (asset.isLoading || !asset.data) return <Skeleton className="h-96" />;
  const a = asset.data;
  const canManage = hasPermission(P['fixed-asset.manage']);
  const canPost = hasPermission(P['fixed-asset.post']);
  const carried = a.status === 'ACTIVE' || a.status === 'FULLY_DEPRECIATED';
  const scheduleTotal = Money.sum(
    a.remainingSchedule.map((m) => Money.of(m, a.currency)),
    a.currency,
  );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{a.assetNumber}</span>
            <span>{a.name}</span>
            <AssetStatusBadge status={a.status} />
          </span>
        }
        description={`${a.categoryCode} · ${a.categoryName}${a.location ? ` · ${a.location}` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={ASSETS_PATH}>
                <ArrowLeft /> Register
              </Link>
            </Button>
            {canManage && a.status !== 'DISPOSED' && a.status !== 'WRITTEN_OFF' ? (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
            {canManage && a.status === 'DRAFT' ? (
              <Button variant="outline" size="sm" onClick={() => setDeleting(true)}>
                <Trash2 /> Delete
              </Button>
            ) : null}
            {canPost && a.status === 'DRAFT' ? (
              <Button size="sm" onClick={() => setAction('capitalize')} data-testid="capitalize">
                Capitalise
              </Button>
            ) : null}
            {canPost && carried ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setAction('transfer')}>
                  Transfer
                </Button>
                <Button variant="outline" size="sm" onClick={() => setAction('impair')}>
                  Impair
                </Button>
                <Button variant="outline" size="sm" onClick={() => setAction('revalue')}>
                  Revalue
                </Button>
                <Button size="sm" onClick={() => setAction('dispose')} data-testid="dispose">
                  Dispose
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {a.status === 'DISPOSED' || a.status === 'WRITTEN_OFF' ? (
        <Alert>
          <AlertTitle>
            {titleCase(a.status)} on {a.disposalDate}
          </AlertTitle>
          <AlertDescription>
            Proceeds {a.disposalProceeds ?? '0'}; {Number(a.disposalGainLoss) < 0 ? 'loss' : 'gain'}{' '}
            {Money.of(a.disposalGainLoss ?? '0', a.currency)
              .abs()
              .toString()}
            . Journal <span className="font-mono">{a.disposalJournalNumber}</span>.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Cost" value={<Amount value={a.cost} className="text-left" />} />
        <Stat
          label="Accumulated depreciation"
          value={<Amount value={a.accumulatedDepreciation} className="text-left" />}
          hint={`${a.depreciatedMonths} of ${a.usefulLifeMonths} months`}
        />
        <Stat
          label="Book value"
          value={<Amount value={a.bookValue} className="text-left" />}
          hint={`Salvage ${a.salvageValue}`}
        />
        <Stat
          label="Next monthly charge"
          value={<Amount value={a.nextDepreciation} className="text-left" zeroAsDash />}
          hint={
            a.status === 'ACTIVE' ? `${a.remainingSchedule.length} months remaining` : undefined
          }
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>
              Every event that changed the carrying amount and its journal.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Book value after</TableHead>
                  <TableHead>Journal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      Not yet capitalised.
                    </TableCell>
                  </TableRow>
                ) : (
                  a.events.map((e) => (
                    <TableRow key={e.id} data-testid="asset-event">
                      <TableCell className="whitespace-nowrap">{e.eventDate}</TableCell>
                      <TableCell>
                        <div className="font-medium">{titleCase(e.eventType)}</div>
                        {e.notes ? (
                          <div className="text-xs text-muted-foreground">{e.notes}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Amount value={e.amount} zeroAsDash />
                      </TableCell>
                      <TableCell>
                        <Amount value={e.bookValueAfter} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {e.journalEntryId ? (
                          <Link
                            href={`/accounting/journal-entries/${e.journalEntryId}`}
                            className="hover:underline"
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
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-sm">
                <Field label="Acquired" value={a.acquisitionDate} />
                <Field label="In service" value={a.inServiceDate} />
                <Field
                  label="Acquisition cost"
                  value={<Amount value={a.acquisitionCost} className="text-left" />}
                />
                <Field
                  label="Method"
                  value={`${methodLabel(a.depreciationMethod, a.decliningRatePercent)} · ${a.usefulLifeMonths} months`}
                />
                <Field label="Serial" value={a.serialNumber ?? '-'} />
                <Field label="Reference" value={a.reference ?? '-'} />
                <Field
                  label="Capitalised"
                  value={
                    a.capitalizationJournalEntryId ? (
                      <Link
                        href={`/accounting/journal-entries/${a.capitalizationJournalEntryId}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {a.capitalizationJournalNumber}
                      </Link>
                    ) : (
                      '-'
                    )
                  }
                />
                <Field label="Created" value={formatDateTime(a.createdAt)} />
              </dl>
              {a.description ? (
                <p className="mt-3 text-sm text-muted-foreground">{a.description}</p>
              ) : null}
            </CardContent>
          </Card>
          {a.remainingSchedule.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Remaining schedule</CardTitle>
                <CardDescription>
                  {a.remainingSchedule.length} months · total {scheduleTotal.toString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableBody>
                    {a.remainingSchedule.slice(0, 12).map((m, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-muted-foreground">Month {i + 1}</TableCell>
                        <TableCell>
                          <Amount value={m} />
                        </TableCell>
                      </TableRow>
                    ))}
                    {a.remainingSchedule.length > 12 ? (
                      <TableRow>
                        <TableCell
                          colSpan={2}
                          className="text-center text-xs text-muted-foreground"
                        >
                          … {a.remainingSchedule.length - 12} more months
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
      <AssetDialog open={editing} asset={a} onOpenChange={setEditing} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${a.assetNumber}?`}
        description="Drafts have no ledger effect and can be removed."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(a.id);
            toast.success('Asset deleted.');
            router.push(ASSETS_PATH);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      <AssetActionDialog asset={a} action={action} onOpenChange={(o) => !o && setAction(null)} />
    </>
  );
}

/** One dialog for the five lifecycle actions; fields depend on the action. */
function AssetActionDialog({
  asset,
  action,
  onOpenChange,
}: {
  asset: FixedAssetDetail;
  action: AssetAction | null;
  onOpenChange: (open: boolean) => void;
}) {
  const run = useAssetAction();
  const [eventDate, setEventDate] = React.useState(today());
  const [amount, setAmount] = React.useState('');
  const [accountId, setAccountId] = React.useState<string | null>(null);
  const [location, setLocation] = React.useState('');
  const [notes, setNotes] = React.useState('');
  React.useEffect(() => {
    if (action) {
      setEventDate(action === 'capitalize' ? asset.acquisitionDate : today());
      setAmount(action === 'dispose' ? '0' : '');
      setAccountId(null);
      setLocation(asset.location ?? '');
      setNotes('');
    }
  }, [action, asset]);
  if (!action) return null;

  const submit = async () => {
    try {
      const text = (v: string) => (v.trim() ? v.trim() : undefined);
      const input =
        action === 'capitalize'
          ? { action, input: { creditAccountId: accountId ?? undefined, postingDate: eventDate } }
          : action === 'transfer'
            ? { action, input: { eventDate, location: text(location), notes: text(notes) } }
            : action === 'impair'
              ? { action, input: { eventDate, amount, notes: text(notes) } }
              : action === 'revalue'
                ? { action, input: { eventDate, newBookValue: amount, notes: text(notes) } }
                : {
                    action,
                    input: {
                      eventDate,
                      proceeds: amount || '0',
                      proceedsAccountId: accountId ?? undefined,
                      notes: text(notes),
                    },
                  };
      const result = await run.mutateAsync({ id: asset.id, ...input });
      toast.success(`${asset.assetNumber} ${titleCase(result.status).toLowerCase()}.`);
      onOpenChange(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  const bookValue = Money.of(asset.bookValue, asset.currency);
  const preview =
    action === 'dispose' && amount !== ''
      ? Money.parse(amount || '0', asset.currency).subtract(bookValue)
      : action === 'impair' && amount
        ? bookValue.subtract(Money.parse(amount, asset.currency))
        : action === 'revalue' && amount
          ? Money.parse(amount, asset.currency).subtract(bookValue)
          : null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {ACTION_LABEL[action]} {asset.assetNumber}
          </DialogTitle>
          <DialogDescription>
            {action === 'capitalize'
              ? 'Posts Dr asset cost / Cr the credit account (defaults to the fixed asset clearing account) and activates depreciation.'
              : action === 'transfer'
                ? 'Records a location change. No ledger effect.'
                : action === 'impair'
                  ? 'Dr impairment loss / Cr accumulated depreciation. The remaining book value spreads over the remaining life.'
                  : action === 'revalue'
                    ? 'Upward revaluation: Dr asset cost / Cr revaluation surplus.'
                    : 'Releases cost and accumulated depreciation; the difference against proceeds is the gain or loss. Zero proceeds = write-off.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{action === 'capitalize' ? 'Posting date' : 'Event date'}</Label>
            <Input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
          </div>
          {action === 'transfer' ? (
            <div className="space-y-1">
              <Label>New location</Label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          ) : null}
          {action === 'impair' || action === 'revalue' || action === 'dispose' ? (
            <div className="space-y-1">
              <Label>
                {action === 'impair'
                  ? 'Impairment amount'
                  : action === 'revalue'
                    ? 'New book value'
                    : 'Proceeds'}
              </Label>
              <Input
                inputMode="decimal"
                className="text-right tabular"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="action-amount"
              />
              <p className="text-xs text-muted-foreground">
                Current book value {asset.bookValue}.
                {preview
                  ? action === 'dispose'
                    ? ` ${preview.isNegative() ? 'Loss' : 'Gain'} ${preview.abs().toString()}.`
                    : action === 'impair'
                      ? ` Book value after ${preview.toString()}.`
                      : ` Increase ${preview.toString()}.`
                  : ''}
              </p>
            </div>
          ) : null}
          {action === 'capitalize' || action === 'dispose' ? (
            <div className="space-y-1">
              <Label>{action === 'capitalize' ? 'Credit account' : 'Proceeds account'}</Label>
              <AccountCombobox
                value={accountId}
                onChange={(id) => setAccountId(id)}
                placeholder={
                  action === 'capitalize' ? 'Fixed asset clearing (default)' : 'Bank / receivable'
                }
                types={['ASSET', 'LIABILITY']}
              />
            </div>
          ) : null}
          {action !== 'capitalize' ? (
            <div className="space-y-1">
              <Label>Notes</Label>
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={run.isPending} data-testid="action-confirm">
            {ACTION_LABEL[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
