'use client';
/* AP-only panels injected into the shared subledger screens where `cfg.side === 'AP'`. */
import * as React from 'react';
import Link from 'next/link';
import { Landmark, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { BILL_HOLD_REASONS, P, VENDOR_HOLD_REASONS } from '@accounting/types';
import {
  Badge,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useAddVendorAddress,
  useAddVendorBankAccount,
  useAddVendorContact,
  useBillHolds,
  useHoldBill,
  useReleaseBillHold,
  useRemoveVendorAddress,
  useRemoveVendorBankAccount,
  useRemoveVendorContact,
  useSubmitBill,
  useUpdateVendorBankAccount,
  useVendorDecision,
  useVendorDetail,
  useVendorHold,
  useVendorPaymentStep,
} from '@/lib/api/payables-hooks';
import type { Party, SubledgerDocument, SubledgerPayment } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { Amount } from '@/components/accounting/primitives';
import { Field, ReasonDialog, StatusBadge } from '@/components/receivables/shared';

// ------------------------------------------------------------- vendor card

/** Onboarding / hold state and payment preferences; balances come from the subledger. */
export function VendorStatusCard({ vendor }: { vendor: Party }) {
  const { hasPermission, hasAuthority } = useSession();
  const detail = useVendorDetail(vendor.id);
  const hold = useVendorHold();
  const decide = useVendorDecision();
  const [holdDialog, setHoldDialog] = React.useState(false);
  const [reason, setReason] = React.useState<(typeof VENDOR_HOLD_REASONS)[number]>('COMPLIANCE');
  const [release, setRelease] = React.useState(false);
  const v = detail.data;
  const status = v?.vendorStatus ?? vendor.vendorStatus ?? 'APPROVED';
  const onHold = status === 'ON_HOLD' || status === 'BLOCKED';
  const canApprove = hasAuthority(P['vendor.approve']);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      setHoldDialog(false);
      setRelease(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            Vendor <StatusBadge status={status} />
            {v?.riskRating && v.riskRating !== 'LOW' ? (
              <Badge variant={v.riskRating === 'HIGH' ? 'destructive' : 'warning'}>
                Risk {v.riskRating.toLowerCase()}
              </Badge>
            ) : null}
            {vendor.balance &&
            'onHold' in vendor.balance &&
            (vendor.balance as { onHold?: string }).onHold !== '0.0000' ? (
              <Badge variant="warning">
                <Amount value={(vendor.balance as { onHold: string }).onHold} className="inline" />{' '}
                on payment hold
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {v?.vendorGroupName ? `${v.vendorGroupName} - ` : ''}
            {v?.paymentTermName ?? `Net ${vendor.paymentTermsDays} days`}
            {v?.withholdingTaxCode ? ` - withholding ${v.withholdingTaxCode}` : ''}
            {v?.buyerName ? ` - buyer ${v.buyerName}` : ''}
            {v?.profile?.paymentMethod ? ` - pays by ${titleCase(v.profile.paymentMethod)}` : ''}
          </CardDescription>
        </div>
        {canApprove ? (
          <div className="flex gap-2">
            {status === 'PENDING' ? (
              <Button
                size="sm"
                onClick={() =>
                  act(
                    () => decide.mutateAsync({ id: vendor.id, decision: 'APPROVE' }),
                    `${vendor.name} approved.`,
                  )
                }
              >
                <ShieldCheck /> Approve vendor
              </Button>
            ) : null}
            {status === 'BLOCKED' ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  act(
                    () => decide.mutateAsync({ id: vendor.id, decision: 'APPROVE' }),
                    `${vendor.name} unblocked.`,
                  )
                }
              >
                <ShieldCheck /> Lift block
              </Button>
            ) : onHold ? (
              <Button size="sm" variant="outline" onClick={() => setRelease(true)}>
                <ShieldCheck /> Release hold
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={() => setHoldDialog(true)}>
                <ShieldAlert /> Place on hold
              </Button>
            )}
          </div>
        ) : null}
      </CardHeader>
      {v?.profile?.holdReason ? (
        <CardContent className="pt-0 text-sm">
          <span className="font-medium">On hold: {titleCase(v.profile.holdReason)}.</span>{' '}
          <span className="text-muted-foreground">{v.profile.holdNote}</span>
          <span className="block text-xs text-muted-foreground">
            No new purchase orders, bills or payments until released.
          </span>
        </CardContent>
      ) : null}
      {status === 'PENDING' ? (
        <CardContent className="pt-0 text-sm text-muted-foreground">
          Awaiting onboarding approval
          {hasPermission(P['vendor.approve']) ? '' : ' by a vendor approver'}; bills cannot be
          recorded yet.
        </CardContent>
      ) : null}
      <Dialog open={holdDialog} onOpenChange={setHoldDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Place {vendor.name} on hold</DialogTitle>
            <DialogDescription>
              Blocks new purchase orders, bills and payments. Existing posted balances are
              untouched.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason">
            <Select value={reason} onValueChange={(r) => setReason(r as typeof reason)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_HOLD_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {titleCase(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <HoldNote
            onConfirm={(note) =>
              act(
                () => hold.mutateAsync({ id: vendor.id, hold: true, reason, note }),
                `${vendor.name} placed on hold.`,
              )
            }
            loading={hold.isPending}
            onCancel={() => setHoldDialog(false)}
          />
        </DialogContent>
      </Dialog>
      <ReasonDialog
        open={release}
        onOpenChange={setRelease}
        title={`Release ${vendor.name}`}
        label="Note"
        required={false}
        confirmLabel="Release"
        loading={hold.isPending}
        onConfirm={(note) =>
          act(
            () => hold.mutateAsync({ id: vendor.id, hold: false, note: note || undefined }),
            `${vendor.name} released.`,
          )
        }
      />
    </Card>
  );
}

function HoldNote({
  onConfirm,
  onCancel,
  loading,
}: {
  onConfirm: (note: string) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const [note, setNote] = React.useState('');
  return (
    <>
      <Field label="Note">
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={loading} onClick={() => onConfirm(note.trim())}>
          Place on hold
        </Button>
      </DialogFooter>
    </>
  );
}

// ------------------------------------------------------------ master tab

export function VendorMasterTab({ vendor }: { vendor: Party }) {
  const { hasPermission } = useSession();
  const detail = useVendorDetail(vendor.id);
  const addContact = useAddVendorContact();
  const removeContact = useRemoveVendorContact();
  const addAddress = useAddVendorAddress();
  const removeAddress = useRemoveVendorAddress();
  const addBank = useAddVendorBankAccount();
  const updateBank = useUpdateVendorBankAccount();
  const removeBank = useRemoveVendorBankAccount();
  const canManage = hasPermission(P['vendor.manage']);
  const [contact, setContact] = React.useState(false);
  const [address, setAddress] = React.useState(false);
  const [bank, setBank] = React.useState(false);
  const [cf, setCf] = React.useState({
    name: '',
    title: '',
    email: '',
    phone: '',
    receivesRemittance: true,
  });
  const [af, setAf] = React.useState({
    addressType: 'REMIT_TO' as 'REMIT_TO' | 'ORDER_FROM' | 'RETURN_TO',
    label: '',
    addressLine1: '',
    city: '',
    province: '',
  });
  const [bf, setBf] = React.useState({
    bankName: '',
    accountName: '',
    accountNumber: '',
    routingCode: '',
  });
  const v = detail.data;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast.success(done);
      setContact(false);
      setAddress(false);
      setBank(false);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Legal name</dt>
            <dd>{vendor.legalName ?? vendor.name}</dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{titleCase(v?.vendorType ?? 'SUPPLIER')}</dd>
            <dt className="text-muted-foreground">Group</dt>
            <dd>{v?.vendorGroupName ?? '-'}</dd>
            <dt className="text-muted-foreground">Payment term</dt>
            <dd>{v?.paymentTermName ?? `Net ${vendor.paymentTermsDays} days`}</dd>
            <dt className="text-muted-foreground">TIN</dt>
            <dd>{vendor.taxIdentificationNumber ?? '-'}</dd>
            <dt className="text-muted-foreground">Withholding</dt>
            <dd>{v?.withholdingTaxCode ?? '-'}</dd>
            <dt className="text-muted-foreground">Industry / region</dt>
            <dd>{[v?.industry, v?.region].filter(Boolean).join(' / ') || '-'}</dd>
            <dt className="text-muted-foreground">Buyer</dt>
            <dd>{v?.buyerName ?? '-'}</dd>
            <dt className="text-muted-foreground">Minimum payment</dt>
            <dd>
              {v?.profile?.minimumPaymentAmount ? (
                <Amount value={v.profile.minimumPaymentAmount} className="inline" />
              ) : (
                '-'
              )}
            </dd>
            <dt className="text-muted-foreground">Bill approval</dt>
            <dd>{v?.profile?.requireBillApproval ? 'Always required' : 'Per AP policy'}</dd>
            <dt className="text-muted-foreground">Review date</dt>
            <dd>{v?.profile?.reviewDate ?? '-'}</dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Bank accounts</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setBank(true)}>
              Add
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {v?.bankAccounts.length ? (
            v.bankAccounts.map((b) => (
              <div
                key={b.id}
                className="flex items-start justify-between gap-2 rounded-md border p-2"
              >
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <Landmark className="h-4 w-4 text-muted-foreground" /> {b.bankName}
                    {b.isPrimary ? <Badge variant="outline">Primary</Badge> : null}
                    {b.verifiedAt ? (
                      <Badge variant="success">Verified</Badge>
                    ) : (
                      <Badge variant="warning">Unverified</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {b.accountName} - <span className="font-mono">{b.accountNumberMasked}</span>
                    {b.routingCode ? ` - ${b.routingCode}` : ''} - {b.currency}
                  </div>
                </div>
                {canManage ? (
                  <div className="flex gap-1">
                    {!b.verifiedAt ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          run(
                            () =>
                              updateBank.mutateAsync({
                                id: vendor.id,
                                bankId: b.id,
                                verified: true,
                              }),
                            'Bank account verified.',
                          )
                        }
                      >
                        Verify
                      </Button>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Remove bank account"
                      onClick={() =>
                        run(
                          () => removeBank.mutateAsync({ id: vendor.id, bankId: b.id }),
                          'Bank account removed.',
                        )
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-muted-foreground">
              No settlement instructions on file; payment runs will export without bank details.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Contacts</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setContact(true)}>
              Add
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {v?.contacts.length ? (
            v.contacts.map((c) => (
              <div
                key={c.id}
                className="flex items-start justify-between gap-2 rounded-md border p-2"
              >
                <div>
                  <div className="font-medium">
                    {c.name} {c.isPrimary ? <Badge variant="outline">Primary</Badge> : null}{' '}
                    {c.receivesRemittance ? <Badge variant="secondary">Remittance</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[c.title, c.email, c.phone].filter(Boolean).join(' - ')}
                  </div>
                </div>
                {canManage ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove contact"
                    onClick={() =>
                      run(
                        () => removeContact.mutateAsync({ id: vendor.id, contactId: c.id }),
                        'Contact removed.',
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-muted-foreground">No contacts yet.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Addresses</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setAddress(true)}>
              Add
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {v?.addresses.length ? (
            v.addresses.map((a) => (
              <div
                key={a.id}
                className="flex items-start justify-between gap-2 rounded-md border p-2"
              >
                <div>
                  <div className="font-medium">
                    {titleCase(a.addressType)} {a.label ? `- ${a.label}` : ''}{' '}
                    {a.isDefault ? <Badge variant="outline">Default</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[a.addressLine1, a.city, a.province, a.country].filter(Boolean).join(', ')}
                  </div>
                </div>
                {canManage ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove address"
                    onClick={() =>
                      run(
                        () => removeAddress.mutateAsync({ id: vendor.id, addressId: a.id }),
                        'Address removed.',
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-muted-foreground">No addresses yet.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={contact} onOpenChange={setContact}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New contact</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} />
            </Field>
            <Field label="Title">
              <Input value={cf.title} onChange={(e) => setCf({ ...cf, title: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input value={cf.email} onChange={(e) => setCf({ ...cf, email: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={cf.phone} onChange={(e) => setCf({ ...cf, phone: e.target.value })} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setContact(false)}>
              Cancel
            </Button>
            <Button
              disabled={!cf.name.trim() || addContact.isPending}
              onClick={() =>
                run(
                  () =>
                    addContact.mutateAsync({
                      id: vendor.id,
                      name: cf.name,
                      title: cf.title || undefined,
                      email: cf.email || undefined,
                      phone: cf.phone || undefined,
                      isPrimary: !v?.contacts.length,
                      receivesRemittance: cf.receivesRemittance,
                    }),
                  'Contact added.',
                )
              }
            >
              Add contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={address} onOpenChange={setAddress}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New address</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type">
              <Select
                value={af.addressType}
                onValueChange={(t) => setAf({ ...af, addressType: t as typeof af.addressType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="REMIT_TO">Remit to</SelectItem>
                  <SelectItem value="ORDER_FROM">Order from</SelectItem>
                  <SelectItem value="RETURN_TO">Return to</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Label">
              <Input value={af.label} onChange={(e) => setAf({ ...af, label: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Address line">
                <Input
                  value={af.addressLine1}
                  onChange={(e) => setAf({ ...af, addressLine1: e.target.value })}
                />
              </Field>
            </div>
            <Field label="City">
              <Input value={af.city} onChange={(e) => setAf({ ...af, city: e.target.value })} />
            </Field>
            <Field label="Province">
              <Input
                value={af.province}
                onChange={(e) => setAf({ ...af, province: e.target.value })}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddress(false)}>
              Cancel
            </Button>
            <Button
              disabled={addAddress.isPending}
              onClick={() =>
                run(
                  () =>
                    addAddress.mutateAsync({
                      id: vendor.id,
                      addressType: af.addressType,
                      label: af.label || undefined,
                      addressLine1: af.addressLine1 || undefined,
                      city: af.city || undefined,
                      province: af.province || undefined,
                      country: 'PH',
                      isDefault: true,
                    }),
                  'Address added.',
                )
              }
            >
              Add address
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bank} onOpenChange={setBank}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New bank account</DialogTitle>
            <DialogDescription>
              Stored for payment files; only the last four digits are shown afterwards.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bank">
              <Input
                value={bf.bankName}
                onChange={(e) => setBf({ ...bf, bankName: e.target.value })}
              />
            </Field>
            <Field label="Account name">
              <Input
                value={bf.accountName}
                onChange={(e) => setBf({ ...bf, accountName: e.target.value })}
              />
            </Field>
            <Field label="Account number">
              <Input
                value={bf.accountNumber}
                onChange={(e) => setBf({ ...bf, accountNumber: e.target.value })}
              />
            </Field>
            <Field label="Routing / SWIFT">
              <Input
                value={bf.routingCode}
                onChange={(e) => setBf({ ...bf, routingCode: e.target.value })}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBank(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                !bf.bankName.trim() ||
                !bf.accountName.trim() ||
                bf.accountNumber.trim().length < 4 ||
                addBank.isPending
              }
              onClick={() =>
                run(
                  () =>
                    addBank.mutateAsync({
                      id: vendor.id,
                      bankName: bf.bankName,
                      accountName: bf.accountName,
                      accountNumber: bf.accountNumber,
                      routingCode: bf.routingCode || undefined,
                      isPrimary: !v?.bankAccounts.length,
                    }),
                  'Bank account added.',
                )
              }
            >
              Add bank account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------- bill actions

export function BillApActions({ document }: { document: SubledgerDocument }) {
  const { hasPermission } = useSession();
  const submit = useSubmitBill();
  const holdBill = useHoldBill();
  const release = useReleaseBillHold();
  const holds = useBillHolds({ billId: document.id, status: 'ACTIVE', pageSize: 1 });
  const [holdDialog, setHoldDialog] = React.useState(false);
  const [reason, setReason] =
    React.useState<(typeof BILL_HOLD_REASONS)[number]>('PRICE_DISCREPANCY');
  const [releaseDialog, setReleaseDialog] = React.useState(false);
  const open =
    document.accountingStatus === 'POSTED' &&
    ['APPROVED', 'PARTIALLY_PAID'].includes(document.status) &&
    document.balance !== '0.0000';
  const activeHold = holds.data?.items[0];
  const canHold = hasPermission(P['bill.hold']);
  return (
    <>
      {document.status === 'DRAFT' && hasPermission(P['bill.create']) ? (
        <Button
          size="sm"
          variant="outline"
          disabled={submit.isPending}
          onClick={async () => {
            try {
              await submit.mutateAsync(document.id);
              toast.success(`${document.documentNumber} submitted for approval.`);
            } catch (err) {
              toast.error(describeError(err));
            }
          }}
        >
          Submit for approval
        </Button>
      ) : null}
      {open && canHold && !document.onHold ? (
        <Button size="sm" variant="outline" onClick={() => setHoldDialog(true)}>
          <ShieldAlert /> Payment hold
        </Button>
      ) : null}
      {document.onHold && canHold && activeHold ? (
        <Button size="sm" variant="outline" onClick={() => setReleaseDialog(true)}>
          <ShieldCheck /> Release hold
        </Button>
      ) : null}
      <Dialog open={holdDialog} onOpenChange={setHoldDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hold {document.documentNumber}</DialogTitle>
            <DialogDescription>
              The liability stays posted; the bill is excluded from payment runs and settlement
              until released.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason">
            <Select value={reason} onValueChange={(r) => setReason(r as typeof reason)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BILL_HOLD_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {titleCase(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <HoldNote
            loading={holdBill.isPending}
            onCancel={() => setHoldDialog(false)}
            onConfirm={async (note) => {
              try {
                await holdBill.mutateAsync({
                  billId: document.id,
                  reason,
                  note: note || undefined,
                });
                toast.success(`${document.documentNumber} placed on payment hold.`);
                setHoldDialog(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          />
        </DialogContent>
      </Dialog>
      <ReasonDialog
        open={releaseDialog}
        onOpenChange={setReleaseDialog}
        title={`Release hold on ${document.documentNumber}`}
        description={
          activeHold
            ? `${titleCase(activeHold.reason)}${activeHold.note ? `: ${activeHold.note}` : ''}`
            : undefined
        }
        label="Note"
        required={false}
        confirmLabel="Release"
        loading={release.isPending}
        onConfirm={async (note) => {
          try {
            await release.mutateAsync({ id: activeHold!.id, note: note || undefined });
            toast.success(`${document.documentNumber} released for payment.`);
            setReleaseDialog(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}

export function BillApBadges({ document }: { document: SubledgerDocument }) {
  return (
    <>
      {document.onHold ? (
        <Badge variant="warning">
          On hold{document.activeHoldReason ? ` - ${titleCase(document.activeHoldReason)}` : ''}
        </Badge>
      ) : null}
      {document.daysOverdue > 0 ? (
        <Badge variant="destructive">Overdue {document.daysOverdue}d</Badge>
      ) : null}
      {document.discountAvailableToday && document.discountAvailableToday !== '0.0000' ? (
        <Badge variant="success">
          Discount <Amount value={document.discountAvailableToday} className="inline" /> until{' '}
          {document.discountDate}
        </Badge>
      ) : null}
      {document.purchaseOrderNumber ? (
        <Link href={`/purchasing/orders/${document.purchaseOrderId}`}>
          <Badge variant="outline">PO {document.purchaseOrderNumber}</Badge>
        </Link>
      ) : null}
    </>
  );
}

// ------------------------------------------------------- payment actions

export function PaymentApActions({ payment }: { payment: SubledgerPayment }) {
  const { hasPermission, hasAuthority } = useSession();
  const step = useVendorPaymentStep();
  const run = async (action: 'submit' | 'approve') => {
    try {
      await step.mutateAsync({ id: payment.id, action });
      toast.success(`${payment.documentNumber} ${action === 'submit' ? 'submitted' : 'approved'}.`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <>
      {payment.status === 'DRAFT' && hasPermission(P['vendor-payment.create']) ? (
        <Button size="sm" variant="outline" onClick={() => run('submit')}>
          Submit for approval
        </Button>
      ) : null}
      {(payment.status === 'DRAFT' || payment.status === 'SUBMITTED') &&
      hasAuthority(P['vendor-payment.approve']) ? (
        <Button size="sm" variant="outline" onClick={() => run('approve')}>
          Approve
        </Button>
      ) : null}
    </>
  );
}
