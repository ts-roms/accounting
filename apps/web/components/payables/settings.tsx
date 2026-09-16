'use client';
import * as React from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
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
  Skeleton,
  Switch,
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
  useApSettings,
  useCreateVendorGroup,
  useUpdateApSettings,
  useUpdateVendorGroup,
  useVendorGroups,
} from '@/lib/api/payables-hooks';
import { usePaymentTerms } from '@/lib/api/receivables-hooks';
import { useSession } from '@/lib/auth/session';
import { AccountCombobox } from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { Field } from '@/components/receivables/shared';

export function ApSettingsPage() {
  const { hasPermission } = useSession();
  const canManage = hasPermission(P['ap-settings.manage']);
  return (
    <>
      <PageHeader
        title="Payables Settings"
        description="AP policy flags, thresholds, aging buckets and vendor groups. Payment terms are shared with receivables."
      />
      <Tabs defaultValue="policy">
        <TabsList>
          <TabsTrigger value="policy">Policy</TabsTrigger>
          <TabsTrigger value="groups">Vendor groups</TabsTrigger>
        </TabsList>
        <TabsContent value="policy">
          <PolicyPanel canManage={canManage} />
        </TabsContent>
        <TabsContent value="groups">
          <GroupsPanel canManage={canManage} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function PolicyPanel({ canManage }: { canManage: boolean }) {
  const settings = useApSettings();
  const update = useUpdateApSettings();
  const terms = usePaymentTerms();
  const [form, setForm] = React.useState<Record<string, string>>({});
  const s = settings.data;
  if (!s) return <Skeleton className="h-64" />;
  const v = (k: keyof typeof s) => form[k] ?? String(s[k] ?? '');
  const toggle =
    (
      k:
        | 'requirePaymentApproval'
        | 'requireRunApproval'
        | 'requireVendorApproval'
        | 'requirePoForStockBills'
        | 'blockDuplicateVendorInvoice',
    ) =>
    async (checked: boolean) => {
      try {
        await update.mutateAsync({ [k]: checked });
        toast.success('Saved.');
      } catch (err) {
        toast.error(describeError(err));
      }
    };
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Controls</CardTitle>
          <CardDescription>Switches take effect immediately.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              [
                'requireVendorApproval',
                'New vendors start pending and must be approved before use',
              ],
              ['requirePaymentApproval', 'Vendor payments must be approved before posting'],
              ['requireRunApproval', 'Payment runs must be approved before execution'],
              [
                'requirePoForStockBills',
                'Bills for stocked products must reference a purchase order',
              ],
              [
                'blockDuplicateVendorInvoice',
                'Block (not just warn on) suspected duplicate supplier invoices',
              ],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between gap-3 text-sm">
              <span>{label}</span>
              <Switch checked={s[k]} disabled={!canManage} onCheckedChange={toggle(k)} />
            </label>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Thresholds and defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="DPO window (days)">
              <Input
                type="number"
                value={v('dpoWindowDays')}
                onChange={(e) => setForm({ ...form, dpoWindowDays: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="Due-soon warning (days)">
              <Input
                type="number"
                value={v('dueSoonDays')}
                onChange={(e) => setForm({ ...form, dueSoonDays: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="Discount lapse warning (days)">
              <Input
                type="number"
                value={v('discountWarnDays')}
                onChange={(e) => setForm({ ...form, discountWarnDays: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="GRNI aged after (days)">
              <Input
                type="number"
                value={v('grniAgeWarnDays')}
                onChange={(e) => setForm({ ...form, grniAgeWarnDays: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field
              label="Bill approval threshold"
              hint="Bills at or above always need an approval workflow"
            >
              <Input
                inputMode="decimal"
                value={form.billApprovalThreshold ?? s.billApprovalThreshold ?? ''}
                onChange={(e) => setForm({ ...form, billApprovalThreshold: e.target.value })}
                disabled={!canManage}
                placeholder="None"
              />
            </Field>
            <Field label="Cash-requirement horizons (days)" hint="Comma separated, e.g. 7, 30, 60">
              <Input
                value={form.horizons ?? s.cashRequirementHorizons.join(', ')}
                onChange={(e) => setForm({ ...form, horizons: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="Default payment term">
              <Select
                value={form.defaultPaymentTermId ?? s.defaultPaymentTermId ?? 'none'}
                onValueChange={(val) => setForm({ ...form, defaultPaymentTermId: val })}
                disabled={!canManage}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {terms.data?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.code} - {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Default cash / bank account for runs">
              <AccountCombobox
                value={form.defaultCashAccountId ?? s.defaultCashAccountId}
                onChange={(id) => setForm({ ...form, defaultCashAccountId: id })}
                types={['ASSET']}
                disabled={!canManage}
              />
            </Field>
          </div>
          {canManage ? (
            <Button
              disabled={update.isPending}
              onClick={async () => {
                try {
                  const horizons = (form.horizons ?? s.cashRequirementHorizons.join(','))
                    .split(',')
                    .map((x) => Number(x.trim()))
                    .filter((x) => Number.isFinite(x) && x > 0);
                  await update.mutateAsync({
                    dpoWindowDays: Number(v('dpoWindowDays')),
                    dueSoonDays: Number(v('dueSoonDays')),
                    discountWarnDays: Number(v('discountWarnDays')),
                    grniAgeWarnDays: Number(v('grniAgeWarnDays')),
                    billApprovalThreshold:
                      (form.billApprovalThreshold ?? s.billApprovalThreshold ?? '') === ''
                        ? null
                        : (form.billApprovalThreshold ?? s.billApprovalThreshold),
                    cashRequirementHorizons: horizons,
                    defaultPaymentTermId:
                      (form.defaultPaymentTermId ?? s.defaultPaymentTermId ?? 'none') === 'none'
                        ? null
                        : (form.defaultPaymentTermId ?? s.defaultPaymentTermId),
                    defaultCashAccountId:
                      form.defaultCashAccountId ?? s.defaultCashAccountId ?? null,
                  });
                  toast.success('Settings saved.');
                  setForm({});
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Save
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm">Aging buckets</CardTitle>
          <CardDescription>
            Contiguous ranges of days past due; the last bucket is open-ended. Change them through
            the API (PATCH /ap-settings). Payment terms are managed under{' '}
            <Link href="/receivables/settings" className="underline">
              Receivables Settings
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {s.agingBuckets.map((b) => (
            <span key={b.key} className="rounded-md border px-2 py-1 text-xs">
              {b.label}: {b.from <= -1000 ? '<=' : b.from}
              {b.to === null ? '+' : b.from <= -1000 ? ` ${b.to}` : ` to ${b.to}`} days
            </span>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function GroupsPanel({ canManage }: { canManage: boolean }) {
  const groups = useVendorGroups();
  const terms = usePaymentTerms();
  const create = useCreateVendorGroup();
  const update = useUpdateVendorGroup();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    code: '',
    name: '',
    term: 'none',
    expenseAccountId: null as string | null,
    requireBillApproval: false,
  });
  const termName = (id: string | null) => terms.data?.find((t) => t.id === id)?.name ?? '-';
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Vendor groups</CardTitle>
          <CardDescription>
            Defaults for new vendors of the group: payment term, expense account, withholding and
            approval policy.
          </CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> New group
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Default term</TableHead>
              <TableHead>Bill approval</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(groups.data ?? []).map((g) => (
              <TableRow key={g.id}>
                <TableCell className="font-mono text-xs">{g.code}</TableCell>
                <TableCell>{g.name}</TableCell>
                <TableCell>{termName(g.defaultPaymentTermId)}</TableCell>
                <TableCell>{g.requireBillApproval ? 'Always' : 'Per policy'}</TableCell>
                <TableCell>
                  <Badge variant={g.status === 'ACTIVE' ? 'success' : 'secondary'}>
                    {g.status}
                  </Badge>
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-2"
                      onClick={async () => {
                        try {
                          await update.mutateAsync({
                            id: g.id,
                            status: g.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                          });
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      {g.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New vendor group</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code">
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Name">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Default payment term">
              <Select value={form.term} onValueChange={(t) => setForm({ ...form, term: t })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {terms.data?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.code} - {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Default expense account">
              <AccountCombobox
                value={form.expenseAccountId}
                onChange={(id) => setForm({ ...form, expenseAccountId: id })}
              />
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
              <span>Bills from this group always require approval</span>
              <Switch
                checked={form.requireBillApproval}
                onCheckedChange={(c) => setForm({ ...form, requireBillApproval: c })}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!form.code || !form.name || create.isPending}
              onClick={async () => {
                try {
                  await create.mutateAsync({
                    code: form.code,
                    name: form.name,
                    defaultPaymentTermId: form.term === 'none' ? null : form.term,
                    defaultExpenseAccountId: form.expenseAccountId,
                    requireBillApproval: form.requireBillApproval,
                  });
                  toast.success('Vendor group created.');
                  setOpen(false);
                  setForm({
                    code: '',
                    name: '',
                    term: 'none',
                    expenseAccountId: null,
                    requireBillApproval: false,
                  });
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
