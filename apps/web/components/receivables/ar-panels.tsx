'use client';
/* AR-only additions to the shared subledger screens: customer credit / master data / collections, invoice and payment actions. */
import * as React from 'react';
import Link from 'next/link';
import { Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
  useAddAddress,
  useAddContact,
  useCollectionCases,
  useCreditHold,
  useCreditSummary,
  useDisputes,
  usePaymentStep,
  usePromises,
  useRefundFromPayment,
  useRemoveAddress,
  useRemoveContact,
  useSubmitInvoice,
  useUpdateCreditProfile,
} from '@/lib/api/receivables-hooks';
import type { Party, SubledgerDocument, SubledgerPayment } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { Amount } from '@/components/accounting/primitives';
import { NewDisputeDialog, NewWriteOffDialog } from './disputes-writeoffs';
import { Field, ReasonDialog, StatusBadge } from './shared';

// -------------------------------------------------------------- customer

export function CustomerCreditCard({ customer }: { customer: Party }) {
  const { hasPermission } = useSession();
  const credit = useCreditSummary(customer.id);
  const hold = useCreditHold();
  const update = useUpdateCreditProfile();
  const [holdDialog, setHoldDialog] = React.useState<'hold' | 'release' | null>(null);
  const [edit, setEdit] = React.useState(false);
  const c = credit.data;
  const canManage = hasPermission(P['customer.credit-manage']);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            Credit {c ? <StatusBadge status={c.status} /> : null}
            {c?.profile.riskRating && c.profile.riskRating !== 'LOW' ? (
              <Badge variant={c.profile.riskRating === 'HIGH' ? 'destructive' : 'warning'}>
                Risk {c.profile.riskRating.toLowerCase()}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Credit used = posted balance + unposted invoices + open orders. Derived, never stored.
          </CardDescription>
        </div>
        {canManage && c ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEdit(true)}>
              Credit profile
            </Button>
            {c.creditHold ? (
              <Button size="sm" variant="outline" onClick={() => setHoldDialog('release')}>
                <ShieldCheck /> Release hold
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={() => setHoldDialog('hold')}>
                <ShieldAlert /> Credit hold
              </Button>
            )}
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {c ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Mini label="Credit limit" value={c.creditLimit ?? '-'} />
            <Mini label="Credit used" value={c.creditUsed} />
            <Mini
              label="Available credit"
              value={c.availableCredit ?? '-'}
              danger={Boolean(c.availableCredit && Number(c.availableCredit) < 0)}
            />
            <Mini
              label="Overdue"
              value={c.overdue}
              danger={Number(c.overdue) > 0}
              hint={c.oldestOverdueDays ? `${c.oldestOverdueDays} days` : undefined}
            />
          </div>
        ) : null}
        {c?.creditHold ? (
          <p className="mt-3 text-sm text-destructive">
            On credit hold
            {c.profile.creditHoldAt ? ` since ${formatDateTime(c.profile.creditHoldAt)}` : ''}:{' '}
            {c.profile.creditHoldReason}
          </p>
        ) : null}
      </CardContent>
      <ReasonDialog
        open={holdDialog !== null}
        onOpenChange={(o) => !o && setHoldDialog(null)}
        title={
          holdDialog === 'hold'
            ? `Place ${customer.name} on credit hold?`
            : `Release the credit hold on ${customer.name}?`
        }
        description={
          holdDialog === 'hold'
            ? 'New sales orders and invoices are blocked until released. Audited; credit managers are notified.'
            : undefined
        }
        confirmLabel={holdDialog === 'hold' ? 'Place on hold' : 'Release'}
        destructive={holdDialog === 'hold'}
        loading={hold.isPending}
        onConfirm={async (reason) => {
          try {
            await hold.mutateAsync({ id: customer.id, hold: holdDialog === 'hold', reason });
            toast.success(holdDialog === 'hold' ? 'Placed on hold.' : 'Hold released.');
            setHoldDialog(null);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
      {c ? (
        <CreditProfileDialog
          open={edit}
          onOpenChange={setEdit}
          customer={customer}
          credit={c}
          onSave={async (input) => {
            try {
              await update.mutateAsync({ id: customer.id, ...input });
              toast.success('Credit profile saved.');
              setEdit(false);
            } catch (err) {
              toast.error(describeError(err));
            }
          }}
        />
      ) : null}
    </Card>
  );
}

function CreditProfileDialog({
  open,
  onOpenChange,
  customer,
  credit,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customer: Party;
  credit: NonNullable<ReturnType<typeof useCreditSummary>['data']>;
  onSave: (input: {
    creditLimit: string | null;
    riskRating: 'LOW' | 'MEDIUM' | 'HIGH';
    reviewDate: string | null;
    notes?: string;
  }) => Promise<void>;
}) {
  const [limit, setLimit] = React.useState(customer.creditLimit ?? '');
  const [risk, setRisk] = React.useState<'LOW' | 'MEDIUM' | 'HIGH'>(credit.profile.riskRating);
  const [review, setReview] = React.useState(credit.profile.reviewDate ?? '');
  const [notes, setNotes] = React.useState(credit.profile.notes ?? '');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Credit profile - {customer.name}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Credit limit" hint="Blank = no limit">
            <Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </Field>
          <Field label="Risk rating">
            <Select value={risk} onValueChange={(v) => setRisk(v as typeof risk)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['LOW', 'MEDIUM', 'HIGH'] as const).map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Next review">
            <Input type="date" value={review} onChange={(e) => setReview(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              void onSave({
                creditLimit: limit || null,
                riskRating: risk,
                reviewDate: review || null,
                notes: notes || undefined,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Mini({
  label,
  value,
  danger,
  hint,
}: {
  label: string;
  value: string;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {value === '-' ? (
        <div className="text-lg">-</div>
      ) : (
        <Amount value={value} className={`text-left text-lg ${danger ? 'text-destructive' : ''}`} />
      )}
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function CustomerMasterTab({ customer }: { customer: Party }) {
  const { hasPermission } = useSession();
  const addContact = useAddContact();
  const removeContact = useRemoveContact();
  const addAddress = useAddAddress();
  const removeAddress = useRemoveAddress();
  const [contact, setContact] = React.useState(false);
  const [address, setAddress] = React.useState(false);
  const canManage = hasPermission(P['customer.manage']);
  const [cf, setCf] = React.useState({ name: '', title: '', email: '', phone: '' });
  const [af, setAf] = React.useState({
    addressType: 'SHIPPING' as 'BILLING' | 'SHIPPING',
    label: '',
    addressLine1: '',
    city: '',
    province: '',
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd>{customer.customerType ?? '-'}</dd>
            <dt className="text-muted-foreground">Group</dt>
            <dd>{customer.customerGroupName ?? '-'}</dd>
            <dt className="text-muted-foreground">Payment term</dt>
            <dd>{customer.paymentTermName ?? `${customer.paymentTermsDays} days`}</dd>
            <dt className="text-muted-foreground">Salesperson</dt>
            <dd>{customer.salespersonName ?? '-'}</dd>
            <dt className="text-muted-foreground">Industry / region</dt>
            <dd>{[customer.industry, customer.region].filter(Boolean).join(' / ') || '-'}</dd>
            <dt className="text-muted-foreground">Currency</dt>
            <dd>{customer.currency}</dd>
            <dt className="text-muted-foreground">Tax</dt>
            <dd>
              {customer.taxIdentificationNumber ?? '-'}
              {customer.taxExempt ? ' (exempt)' : ''}
            </dd>
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Contacts</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setContact(true)}>
              <Plus /> Contact
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {customer.contacts?.length ? (
                customer.contacts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div>
                        {c.name}
                        {c.isPrimary ? (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            primary
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[c.title, c.email, c.phone].filter(Boolean).join(' - ')}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeContact.mutate({ id: customer.id, contactId: c.id })}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="py-6 text-center text-sm text-muted-foreground">
                    No contacts.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Addresses</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setAddress(true)}>
              <Plus /> Address
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Type</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Address</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {customer.addresses?.length ? (
                customer.addresses.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      {a.addressType}
                      {a.isDefault ? (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          default
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{a.label ?? '-'}</TableCell>
                    <TableCell>
                      {[a.addressLine1, a.city, a.province, a.country].filter(Boolean).join(', ')}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeAddress.mutate({ id: customer.id, addressId: a.id })}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                    Only the head-office address on the customer record.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
              disabled={!cf.name}
              onClick={async () => {
                try {
                  await addContact.mutateAsync({
                    id: customer.id,
                    name: cf.name,
                    title: cf.title || undefined,
                    email: cf.email || undefined,
                    phone: cf.phone || undefined,
                    isPrimary: !customer.contacts?.length,
                  });
                  setContact(false);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Add
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
                onValueChange={(v) => setAf({ ...af, addressType: v as typeof af.addressType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BILLING">Billing</SelectItem>
                  <SelectItem value="SHIPPING">Shipping</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Label">
              <Input value={af.label} onChange={(e) => setAf({ ...af, label: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Address">
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
              disabled={!af.addressLine1}
              onClick={async () => {
                try {
                  await addAddress.mutateAsync({
                    id: customer.id,
                    addressType: af.addressType,
                    label: af.label || undefined,
                    addressLine1: af.addressLine1,
                    city: af.city || undefined,
                    province: af.province || undefined,
                    country: 'PH',
                    isDefault: true,
                  });
                  setAddress(false);
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CustomerCollectionsTab({ customerId }: { customerId: string }) {
  const cases = useCollectionCases({ customerId, pageSize: 20 });
  const promises = usePromises({ customerId, pageSize: 20 });
  const disputes = useDisputes({ customerId, pageSize: 20 });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Collection cases</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {cases.data?.items.length ? (
                cases.data.items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/receivables/collections/${c.id}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {c.documentNumber}
                      </Link>
                      <div className="text-xs text-muted-foreground">{c.nextAction ?? ''}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <StatusBadge status={c.status} />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="py-6 text-center text-sm text-muted-foreground">
                    No cases.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Promises to pay</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {promises.data?.items.length ? (
                promises.data.items.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Amount value={p.amount} className="text-left" />
                      <div className="text-xs text-muted-foreground">by {p.promiseDate}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <StatusBadge status={p.status} />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="py-6 text-center text-sm text-muted-foreground">
                    No promises.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Disputes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {disputes.data?.items.length ? (
                disputes.data.items.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <span className="font-mono text-xs">{d.invoiceNumber}</span>
                      <div className="text-xs text-muted-foreground">
                        {d.reason.replace(/_/g, ' ').toLowerCase()}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <StatusBadge status={d.status} />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell className="py-6 text-center text-sm text-muted-foreground">
                    No disputes.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// --------------------------------------------------------------- invoices

/** Submit / dispute / write-off actions and O2C links for AR documents. */
export function InvoiceArActions({ document }: { document: SubledgerDocument }) {
  const { hasPermission } = useSession();
  const submit = useSubmitInvoice();
  const [dispute, setDispute] = React.useState(false);
  const [writeOff, setWriteOff] = React.useState(false);
  const isDebit = document.documentType !== 'CREDIT_NOTE';
  const open =
    document.accountingStatus === 'POSTED' &&
    ['APPROVED', 'PARTIALLY_PAID'].includes(document.status) &&
    document.balance !== '0.0000';
  return (
    <>
      {document.status === 'DRAFT' && hasPermission(P['invoice.create']) ? (
        <Button
          size="sm"
          variant="outline"
          disabled={submit.isPending}
          onClick={async () => {
            try {
              const r = await submit.mutateAsync(document.id);
              toast.success(
                `${document.documentNumber} submitted${r.warnings?.length ? ` with ${r.warnings.length} credit warning(s)` : ''}.`,
              );
            } catch (err) {
              toast.error(describeError(err));
            }
          }}
        >
          Submit for approval
        </Button>
      ) : null}
      {isDebit && open && hasPermission(P['dispute.manage']) && !document.openDisputes ? (
        <Button size="sm" variant="outline" onClick={() => setDispute(true)}>
          Open dispute
        </Button>
      ) : null}
      {isDebit && open && hasPermission(P['write-off.create']) ? (
        <Button size="sm" variant="outline" onClick={() => setWriteOff(true)}>
          Request write-off
        </Button>
      ) : null}
      {dispute ? <NewDisputeDialog open onOpenChange={setDispute} invoiceId={document.id} /> : null}
      {writeOff ? (
        <NewWriteOffDialog open onOpenChange={setWriteOff} invoiceId={document.id} />
      ) : null}
    </>
  );
}

export function InvoiceArBadges({ document }: { document: SubledgerDocument }) {
  return (
    <>
      {document.openDisputes ? <Badge variant="destructive">Disputed</Badge> : null}
      {document.daysOverdue > 0 ? (
        <Badge variant="destructive">Overdue {document.daysOverdue}d</Badge>
      ) : null}
      {document.deliveryNumber ? (
        <Link href={`/receivables/deliveries/${document.deliveryId}`}>
          <Badge variant="outline">Delivery {document.deliveryNumber}</Badge>
        </Link>
      ) : null}
      {document.salesOrderNumber ? (
        <Link href={`/sales/orders/${document.salesOrderId}`}>
          <Badge variant="outline">{document.salesOrderNumber}</Badge>
        </Link>
      ) : null}
    </>
  );
}

// --------------------------------------------------------------- payments

export function PaymentArActions({ payment }: { payment: SubledgerPayment }) {
  const { hasPermission, hasAuthority } = useSession();
  const step = usePaymentStep();
  const refund = useRefundFromPayment();
  const [refundDialog, setRefundDialog] = React.useState(false);
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
      {payment.status === 'DRAFT' && hasPermission(P['customer-payment.create']) ? (
        <Button size="sm" variant="outline" onClick={() => run('submit')}>
          Submit for approval
        </Button>
      ) : null}
      {(payment.status === 'DRAFT' || payment.status === 'SUBMITTED') &&
      hasAuthority(P['customer-payment.approve']) ? (
        <Button size="sm" variant="outline" onClick={() => run('approve')}>
          Approve
        </Button>
      ) : null}
      {payment.status === 'POSTED' &&
      payment.paymentType === 'PAYMENT' &&
      payment.unallocatedAmount !== '0.0000' &&
      hasPermission(P['customer-refund.create']) ? (
        <Button size="sm" variant="outline" onClick={() => setRefundDialog(true)}>
          Request refund
        </Button>
      ) : null}
      <ReasonDialog
        open={refundDialog}
        onOpenChange={setRefundDialog}
        title={`Refund ${payment.unallocatedAmount} unapplied?`}
        description="Creates a refund request that must be approved by someone else before it is paid (Dr AR / Cr cash)."
        label="Reason"
        confirmLabel="Request refund"
        loading={refund.isPending}
        onConfirm={async (reason) => {
          try {
            const r = await refund.mutateAsync({ paymentId: payment.id, reason });
            toast.success(`${r.documentNumber} requested.`);
            setRefundDialog(false);
          } catch (err) {
            toast.error(describeError(err));
          }
        }}
      />
    </>
  );
}
