'use client';
import * as React from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  CREDIT_RULE_ACTIONS,
  CREDIT_RULE_SCOPES,
  CREDIT_RULE_TRIGGERS,
  DUNNING_ACTIONS,
  P,
  PAYMENT_TERM_BASES,
} from '@accounting/types';
import {
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
  useArSettings,
  useCreateCreditRule,
  useCreateCustomerGroup,
  useCreateDunningPolicy,
  useCreatePaymentTerm,
  useCreditRules,
  useCustomerGroups,
  useDunningPolicies,
  usePaymentTerms,
  useUpdateArSettings,
  useUpdateCreditRule,
  useUpdateCustomerGroup,
  useUpdateDunningPolicy,
  useUpdatePaymentTerm,
} from '@/lib/api/receivables-hooks';
import { useSession } from '@/lib/auth/session';
import { titleCase } from '@/lib/format';
import { PageHeader } from '@/components/ui-ext/page';
import { Field, StatusBadge } from './shared';

export function ArSettingsPage() {
  const { hasPermission } = useSession();
  const canManage = hasPermission(P['ar-settings.manage']);
  return (
    <>
      <PageHeader
        title="Receivables Settings"
        description="Payment terms, customer groups, credit rules, dunning policies and the AR policy flags. Business rules live here, not in code."
      />
      <Tabs defaultValue="policy">
        <TabsList>
          <TabsTrigger value="policy">Policy</TabsTrigger>
          <TabsTrigger value="terms">Payment terms</TabsTrigger>
          <TabsTrigger value="groups">Customer groups</TabsTrigger>
          <TabsTrigger value="credit">Credit rules</TabsTrigger>
          <TabsTrigger value="dunning">Dunning</TabsTrigger>
        </TabsList>
        <TabsContent value="policy">
          <PolicyPanel canManage={canManage} />
        </TabsContent>
        <TabsContent value="terms">
          <TermsPanel canManage={canManage} />
        </TabsContent>
        <TabsContent value="groups">
          <GroupsPanel canManage={canManage} />
        </TabsContent>
        <TabsContent value="credit">
          <CreditRulesPanel canManage={canManage} />
        </TabsContent>
        <TabsContent value="dunning">
          <DunningPanel canManage={canManage} />
        </TabsContent>
      </Tabs>
    </>
  );
}

function PolicyPanel({ canManage }: { canManage: boolean }) {
  const settings = useArSettings();
  const update = useUpdateArSettings();
  const terms = usePaymentTerms();
  const policies = useDunningPolicies();
  const [form, setForm] = React.useState<Record<string, string>>({});
  const s = settings.data;
  if (!s) return <Skeleton className="h-64" />;
  const v = (k: keyof typeof s) => form[k] ?? String(s[k] ?? '');
  const toggle =
    (
      k:
        | 'requirePaymentApproval'
        | 'useAllowanceForBadDebt'
        | 'creditCheckOnSalesOrder'
        | 'creditCheckOnInvoice',
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
                'creditCheckOnSalesOrder',
                'Run credit rules when a sales order is submitted / approved',
              ],
              ['creditCheckOnInvoice', 'Run credit rules when an invoice is submitted / approved'],
              ['requirePaymentApproval', 'Customer payments must be approved before posting'],
              [
                'useAllowanceForBadDebt',
                'Bad-debt write-offs debit the allowance (off = straight to expense)',
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
            <Field label="DSO window (days)">
              <Input
                type="number"
                value={v('dsoWindowDays')}
                onChange={(e) => setForm({ ...form, dsoWindowDays: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="Unapplied cash warning (days)">
              <Input
                type="number"
                value={v('unappliedCashWarnDays')}
                onChange={(e) => setForm({ ...form, unappliedCashWarnDays: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="Small-balance write-off limit">
              <Input
                inputMode="decimal"
                value={v('smallBalanceThreshold')}
                onChange={(e) => setForm({ ...form, smallBalanceThreshold: e.target.value })}
                disabled={!canManage}
              />
            </Field>
            <Field label="Auto-open case at (days overdue, 0 = never)">
              <Input
                type="number"
                value={v('autoCaseDaysOverdue')}
                onChange={(e) => setForm({ ...form, autoCaseDaysOverdue: e.target.value })}
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
            <Field label="Default dunning policy">
              <Select
                value={form.defaultDunningPolicyId ?? s.defaultDunningPolicyId ?? 'none'}
                onValueChange={(val) => setForm({ ...form, defaultDunningPolicyId: val })}
                disabled={!canManage}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (no automatic dunning)</SelectItem>
                  {policies.data?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field
            label="Allowance rates per aging bucket (%)"
            hint="Used by AGING_PERCENT provisioning runs."
          >
            <div className="grid grid-cols-3 gap-2">
              {s.agingBuckets.map((b) => (
                <div key={b.key} className="space-y-1">
                  <span className="text-xs text-muted-foreground">{b.label}</span>
                  <Input
                    inputMode="decimal"
                    value={form[`rate:${b.key}`] ?? s.provisionRates[b.key] ?? '0'}
                    onChange={(e) => setForm({ ...form, [`rate:${b.key}`]: e.target.value })}
                    disabled={!canManage}
                  />
                </div>
              ))}
            </div>
          </Field>
          {canManage ? (
            <Button
              disabled={update.isPending}
              onClick={async () => {
                try {
                  const rates: Record<string, string> = {};
                  for (const b of s.agingBuckets)
                    rates[b.key] = form[`rate:${b.key}`] ?? s.provisionRates[b.key] ?? '0';
                  await update.mutateAsync({
                    dsoWindowDays: Number(v('dsoWindowDays')),
                    unappliedCashWarnDays: Number(v('unappliedCashWarnDays')),
                    smallBalanceThreshold: v('smallBalanceThreshold'),
                    autoCaseDaysOverdue: Number(v('autoCaseDaysOverdue')),
                    defaultPaymentTermId:
                      (form.defaultPaymentTermId ?? s.defaultPaymentTermId ?? 'none') === 'none'
                        ? null
                        : (form.defaultPaymentTermId ?? s.defaultPaymentTermId),
                    defaultDunningPolicyId:
                      (form.defaultDunningPolicyId ?? s.defaultDunningPolicyId ?? 'none') === 'none'
                        ? null
                        : (form.defaultDunningPolicyId ?? s.defaultDunningPolicyId),
                    provisionRates: rates,
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
            the API (PATCH /ar-settings) when your reporting needs differ.
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

function TermsPanel({ canManage }: { canManage: boolean }) {
  const terms = usePaymentTerms();
  const create = useCreatePaymentTerm();
  const update = useUpdatePaymentTerm();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({
    code: '',
    name: '',
    basis: 'NET_DAYS' as (typeof PAYMENT_TERM_BASES)[number],
    days: '30',
    dayOfMonth: '15',
  });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Payment terms</CardTitle>
          <CardDescription>COD, NET 7 ... NET 90, end of month, day of next month.</CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> New term
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Basis</TableHead>
              <TableHead>Days</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {terms.data?.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-mono text-xs">{t.code}</TableCell>
                <TableCell>{t.name}</TableCell>
                <TableCell>{titleCase(t.basis)}</TableCell>
                <TableCell>
                  {t.basis === 'DAY_OF_NEXT_MONTH' ? `day ${t.dayOfMonth}` : t.days}
                </TableCell>
                <TableCell>
                  <StatusBadge status={t.status} />
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        update.mutate({
                          id: t.id,
                          status: t.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                        })
                      }
                    >
                      {t.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
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
            <DialogTitle>New payment term</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code">
              <Input
                value={f.code}
                onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Name">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Basis">
              <Select
                value={f.basis}
                onValueChange={(val) => setF({ ...f, basis: val as typeof f.basis })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_TERM_BASES.map((b) => (
                    <SelectItem key={b} value={b}>
                      {titleCase(b)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {f.basis === 'DAY_OF_NEXT_MONTH' ? (
              <Field label="Day of month">
                <Input
                  type="number"
                  value={f.dayOfMonth}
                  onChange={(e) => setF({ ...f, dayOfMonth: e.target.value })}
                />
              </Field>
            ) : (
              <Field label="Days">
                <Input
                  type="number"
                  value={f.days}
                  onChange={(e) => setF({ ...f, days: e.target.value })}
                />
              </Field>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!f.code || !f.name || create.isPending}
              onClick={async () => {
                try {
                  await create.mutateAsync({
                    code: f.code,
                    name: f.name,
                    basis: f.basis,
                    days: Number(f.days),
                    dayOfMonth: f.basis === 'DAY_OF_NEXT_MONTH' ? Number(f.dayOfMonth) : undefined,
                    discountPercent: '0',
                    discountDays: 0,
                  });
                  toast.success('Term created.');
                  setOpen(false);
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

function GroupsPanel({ canManage }: { canManage: boolean }) {
  const groups = useCustomerGroups();
  const terms = usePaymentTerms();
  const policies = useDunningPolicies();
  const create = useCreateCustomerGroup();
  const update = useUpdateCustomerGroup();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({
    code: '',
    name: '',
    paymentTermId: 'none',
    defaultCreditLimit: '',
    priceDiscountPercent: '0',
    dunningPolicyId: 'none',
  });
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Customer groups</CardTitle>
          <CardDescription>
            Defaults for terms, credit limit, pricing and dunning applied to new customers in the
            group.
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
              <TableHead>Term</TableHead>
              <TableHead className="text-right">Default limit</TableHead>
              <TableHead>Discount</TableHead>
              <TableHead>Dunning</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.data?.map((g) => (
              <TableRow key={g.id}>
                <TableCell className="font-mono text-xs">{g.code}</TableCell>
                <TableCell>{g.name}</TableCell>
                <TableCell>
                  {terms.data?.find((t) => t.id === g.paymentTermId)?.code ?? '-'}
                </TableCell>
                <TableCell className="text-right">{g.defaultCreditLimit ?? '-'}</TableCell>
                <TableCell>{g.priceDiscountPercent}%</TableCell>
                <TableCell>
                  {policies.data?.find((p) => p.id === g.dunningPolicyId)?.name ?? '-'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={g.status} />
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        update.mutate({
                          id: g.id,
                          status: g.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                        })
                      }
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
            <DialogTitle>New customer group</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code">
              <Input
                value={f.code}
                onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Name">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Payment term">
              <Select
                value={f.paymentTermId}
                onValueChange={(val) => setF({ ...f, paymentTermId: val })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Company default</SelectItem>
                  {terms.data?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Default credit limit">
              <Input
                inputMode="decimal"
                value={f.defaultCreditLimit}
                onChange={(e) => setF({ ...f, defaultCreditLimit: e.target.value })}
              />
            </Field>
            <Field label="Price discount %">
              <Input
                inputMode="decimal"
                value={f.priceDiscountPercent}
                onChange={(e) => setF({ ...f, priceDiscountPercent: e.target.value })}
              />
            </Field>
            <Field label="Dunning policy">
              <Select
                value={f.dunningPolicyId}
                onValueChange={(val) => setF({ ...f, dunningPolicyId: val })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Company default</SelectItem>
                  {policies.data?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!f.code || !f.name || create.isPending}
              onClick={async () => {
                try {
                  await create.mutateAsync({
                    code: f.code,
                    name: f.name,
                    paymentTermId: f.paymentTermId === 'none' ? null : f.paymentTermId,
                    defaultCreditLimit: f.defaultCreditLimit || null,
                    priceDiscountPercent: f.priceDiscountPercent || '0',
                    dunningPolicyId: f.dunningPolicyId === 'none' ? null : f.dunningPolicyId,
                  });
                  toast.success('Group created.');
                  setOpen(false);
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

function CreditRulesPanel({ canManage }: { canManage: boolean }) {
  const rules = useCreditRules();
  const groups = useCustomerGroups();
  const create = useCreateCreditRule();
  const update = useUpdateCreditRule();
  const [open, setOpen] = React.useState(false);
  const [f, setF] = React.useState({
    name: '',
    scope: 'SALES_ORDER' as (typeof CREDIT_RULE_SCOPES)[number],
    trigger: 'EXPOSURE_OVER_LIMIT' as (typeof CREDIT_RULE_TRIGGERS)[number],
    action: 'REQUIRE_APPROVAL' as (typeof CREDIT_RULE_ACTIONS)[number],
    thresholdAmount: '',
    thresholdPercent: '',
    thresholdDays: '',
    customerGroupId: 'none',
    priority: '100',
  });
  const describe = (r: NonNullable<typeof rules.data>[number]) => {
    switch (r.trigger) {
      case 'EXPOSURE_OVER_LIMIT':
        return `exposure > limit${r.thresholdPercent && r.thresholdPercent !== '0.0000' ? ` + ${r.thresholdPercent}%` : ''}`;
      case 'OVERDUE_BALANCE':
        return `overdue > ${r.thresholdAmount}`;
      case 'DAYS_OVERDUE':
        return `oldest overdue > ${r.thresholdDays} days`;
      case 'CREDIT_HOLD':
        return 'customer on hold';
      case 'NO_CREDIT_LIMIT':
        return 'no credit limit';
    }
  };
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Credit rules</CardTitle>
          <CardDescription>
            Evaluated in priority order when sales orders / invoices are submitted or approved. WARN
            annotates, REQUIRE_APPROVAL routes to an approver, BLOCK stops the document.
          </CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> New rule
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>#</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Then</TableHead>
              <TableHead>Group</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.data?.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.priority}</TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell>{titleCase(r.scope)}</TableCell>
                <TableCell className="text-xs">{describe(r)}</TableCell>
                <TableCell>
                  <StatusBadge
                    status={
                      r.action === 'BLOCK'
                        ? 'CANCELLED'
                        : r.action === 'REQUIRE_APPROVAL'
                          ? 'SUBMITTED'
                          : 'OPEN'
                    }
                  />{' '}
                  <span className="text-xs">{titleCase(r.action)}</span>
                </TableCell>
                <TableCell>
                  {groups.data?.find((g) => g.id === r.customerGroupId)?.code ?? 'All'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        update.mutate({
                          id: r.id,
                          status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                        })
                      }
                    >
                      {r.status === 'ACTIVE' ? 'Disable' : 'Enable'}
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
            <DialogTitle>New credit rule</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Name">
                <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
            </div>
            <Field label="Scope">
              <Select
                value={f.scope}
                onValueChange={(val) => setF({ ...f, scope: val as typeof f.scope })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_RULE_SCOPES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Trigger">
              <Select
                value={f.trigger}
                onValueChange={(val) => setF({ ...f, trigger: val as typeof f.trigger })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_RULE_TRIGGERS.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Action">
              <Select
                value={f.action}
                onValueChange={(val) => setF({ ...f, action: val as typeof f.action })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_RULE_ACTIONS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {titleCase(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Priority">
              <Input
                type="number"
                value={f.priority}
                onChange={(e) => setF({ ...f, priority: e.target.value })}
              />
            </Field>
            {f.trigger === 'OVERDUE_BALANCE' ? (
              <Field label="Threshold amount">
                <Input
                  inputMode="decimal"
                  value={f.thresholdAmount}
                  onChange={(e) => setF({ ...f, thresholdAmount: e.target.value })}
                />
              </Field>
            ) : null}
            {f.trigger === 'EXPOSURE_OVER_LIMIT' ? (
              <Field label="Tolerance over limit (%)">
                <Input
                  inputMode="decimal"
                  value={f.thresholdPercent}
                  onChange={(e) => setF({ ...f, thresholdPercent: e.target.value })}
                />
              </Field>
            ) : null}
            {f.trigger === 'DAYS_OVERDUE' ? (
              <Field label="Threshold days">
                <Input
                  type="number"
                  value={f.thresholdDays}
                  onChange={(e) => setF({ ...f, thresholdDays: e.target.value })}
                />
              </Field>
            ) : null}
            <Field label="Customer group">
              <Select
                value={f.customerGroupId}
                onValueChange={(val) => setF({ ...f, customerGroupId: val })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Every customer</SelectItem>
                  {groups.data?.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!f.name || create.isPending}
              onClick={async () => {
                try {
                  await create.mutateAsync({
                    name: f.name,
                    scope: f.scope,
                    trigger: f.trigger,
                    action: f.action,
                    thresholdAmount: f.thresholdAmount || null,
                    thresholdPercent: f.thresholdPercent || null,
                    thresholdDays: f.thresholdDays ? Number(f.thresholdDays) : null,
                    customerGroupId: f.customerGroupId === 'none' ? null : f.customerGroupId,
                    priority: Number(f.priority),
                  });
                  toast.success('Rule created.');
                  setOpen(false);
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

function DunningPanel({ canManage }: { canManage: boolean }) {
  const policies = useDunningPolicies();
  const create = useCreateDunningPolicy();
  const update = useUpdateDunningPolicy();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [minimum, setMinimum] = React.useState('0');
  const [steps, setSteps] = React.useState([
    { daysOverdue: '0', action: 'REMINDER', label: 'Payment due' },
    { daysOverdue: '7', action: 'REMINDER', label: 'First reminder' },
    { daysOverdue: '30', action: 'ESCALATION', label: 'Escalation' },
  ]);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-sm">Dunning policies</CardTitle>
          <CardDescription>
            Steps by days overdue. Nothing runs without a policy; disputed invoices are never
            dunned; every step is recorded on the collection case.
          </CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> New policy
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Policy</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead className="text-right">Minimum</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.data?.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <div>{p.name}</div>
                  <div className="text-xs text-muted-foreground">{p.description}</div>
                </TableCell>
                <TableCell className="text-xs">
                  {p.steps.map((s) => `${s.daysOverdue}d ${titleCase(s.action)}`).join(' -> ')}
                </TableCell>
                <TableCell className="text-right">{p.minimumAmount}</TableCell>
                <TableCell>{p.isDefault ? 'Yes' : ''}</TableCell>
                <TableCell>
                  <StatusBadge status={p.status} />
                </TableCell>
                <TableCell className="text-right">
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        update.mutate({
                          id: p.id,
                          status: p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
                        })
                      }
                    >
                      {p.status === 'ACTIVE' ? 'Disable' : 'Enable'}
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
            <DialogTitle>New dunning policy</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Minimum overdue amount">
                <Input
                  inputMode="decimal"
                  value={minimum}
                  onChange={(e) => setMinimum(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Steps (ascending days)">
              <div className="space-y-2">
                {steps.map((s, i) => (
                  <div key={i} className="grid grid-cols-[80px_1fr_1fr_auto] gap-2">
                    <Input
                      type="number"
                      value={s.daysOverdue}
                      onChange={(e) =>
                        setSteps(
                          steps.map((x, j) =>
                            j === i ? { ...x, daysOverdue: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    <Select
                      value={s.action}
                      onValueChange={(val) =>
                        setSteps(steps.map((x, j) => (j === i ? { ...x, action: val } : x)))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DUNNING_ACTIONS.map((a) => (
                          <SelectItem key={a} value={a}>
                            {titleCase(a)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={s.label}
                      onChange={(e) =>
                        setSteps(
                          steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                    >
                      x
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSteps([
                      ...steps,
                      { daysOverdue: '60', action: 'CREDIT_HOLD', label: 'Credit hold' },
                    ])
                  }
                >
                  <Plus /> Step
                </Button>
              </div>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name || create.isPending}
              onClick={async () => {
                try {
                  await create.mutateAsync({
                    name,
                    minimumAmount: minimum || '0',
                    isDefault: false,
                    steps: steps.map((s) => ({
                      daysOverdue: Number(s.daysOverdue),
                      action: s.action as (typeof DUNNING_ACTIONS)[number],
                      label: s.label,
                    })),
                  });
                  toast.success('Policy created.');
                  setOpen(false);
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
