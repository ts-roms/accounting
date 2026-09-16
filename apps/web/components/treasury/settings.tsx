'use client';
import * as React from 'react';
import { Pencil, PlayCircle, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { BankAccountType, ForecastGranularity, PaymentFileFormat } from '@accounting/types';
import {
  BANK_ACCOUNT_TYPES,
  FORECAST_GRANULARITIES,
  P,
  PAYMENT_FILE_FORMATS,
} from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useBankAccounts } from '@/lib/api/assets-banking-hooks';
import {
  useBankAccountProfile,
  useRunTreasurySweep,
  useTreasuryIntegrity,
  useTreasurySettings,
  useUpdateBankAccountProfile,
  useUpdateTreasurySettings,
} from '@/lib/api/treasury-hooks';
import type { BankAccount } from '@/lib/api/types';
import { titleCase } from '@/lib/format';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { today } from '@/components/accounting/primitives';
import { Field, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from './shared';

const SCENARIOS = ['BASE', 'OPTIMISTIC', 'PESSIMISTIC'] as const;

/** Treasury policy: forecast horizon and scenarios, liquidity floor, approval threshold, payment file defaults; per-account profiles; integrity and the sweep. */
export function TreasurySettingsPage() {
  const settings = useTreasurySettings();
  const update = useUpdateTreasurySettings();
  const sweep = useRunTreasurySweep();
  const s = settings.data;
  const [form, setForm] = React.useState<Record<string, string>>({});
  const [scenarios, setScenarios] = React.useState<
    Record<string, { inflowFactor: string; outflowFactor: string; inflowDelayDays: string }>
  >({});
  React.useEffect(() => {
    if (!s) return;
    setForm({
      forecastHorizonDays: String(s.forecastHorizonDays),
      forecastGranularity: s.forecastGranularity,
      minimumDaysCashOnHand: String(s.minimumDaysCashOnHand),
      burnWindowDays: String(s.burnWindowDays),
      transferApprovalThreshold: s.transferApprovalThreshold ?? '',
      unsettledTransferWarnDays: String(s.unsettledTransferWarnDays),
      defaultPaymentFileFormat: s.defaultPaymentFileFormat,
      originatorName: s.originatorName ?? '',
      pettyCashVoucherLimit: s.pettyCashVoucherLimit ?? '',
    });
    setScenarios(
      Object.fromEntries(
        SCENARIOS.map((k) => [
          k,
          {
            inflowFactor: s.scenarios[k]?.inflowFactor ?? '1',
            outflowFactor: s.scenarios[k]?.outflowFactor ?? '1',
            inflowDelayDays: String(s.scenarios[k]?.inflowDelayDays ?? 0),
          },
        ]),
      ),
    );
  }, [s]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <>
      <PageHeader
        title="Treasury Settings"
        description="Policy is data: the forecast horizon, collection scenarios, liquidity floor, transfer approval threshold and payment file defaults live here, never in code."
        actions={
          <Can permissions={[P['treasury-settings.manage']]}>
            <Button
              size="sm"
              variant="outline"
              disabled={sweep.isPending}
              onClick={async () => {
                try {
                  const r = await sweep.mutateAsync(today());
                  toast.success(
                    `Sweep complete: ${r.belowMinimum} account(s) below minimum, ${r.forecastBreaches} forecast breach(es), ${r.unsettledTransfers} unsettled transfer(s), ${r.pettyCashLow} fund(s) low.`,
                  );
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              <PlayCircle /> Run daily sweep now
            </Button>
          </Can>
        }
      />
      <QueryState query={settings}>
        {(s) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Forecast and liquidity</CardTitle>
                <CardDescription>
                  The floor is the larger of average daily outflow x days cash on hand and the sum
                  of account minimums.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <Field label="Forecast horizon (days)">
                  <Input
                    inputMode="numeric"
                    value={form.forecastHorizonDays ?? ''}
                    onChange={set('forecastHorizonDays')}
                  />
                </Field>
                <Field label="Default granularity">
                  <Select
                    value={form.forecastGranularity ?? 'WEEK'}
                    onValueChange={(v) => setForm((p) => ({ ...p, forecastGranularity: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FORECAST_GRANULARITIES.map((g) => (
                        <SelectItem key={g} value={g}>
                          {titleCase(g)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Minimum days cash on hand">
                  <Input
                    inputMode="numeric"
                    value={form.minimumDaysCashOnHand ?? ''}
                    onChange={set('minimumDaysCashOnHand')}
                  />
                </Field>
                <Field label="Burn window (days)" hint="Trailing window for average daily outflow">
                  <Input
                    inputMode="numeric"
                    value={form.burnWindowDays ?? ''}
                    onChange={set('burnWindowDays')}
                  />
                </Field>
                <Field
                  label="Transfer approval threshold"
                  hint="Blank = every transfer needs approval"
                >
                  <Input
                    inputMode="decimal"
                    value={form.transferApprovalThreshold ?? ''}
                    onChange={set('transferApprovalThreshold')}
                  />
                </Field>
                <Field label="Warn when unsettled after (days)">
                  <Input
                    inputMode="numeric"
                    value={form.unsettledTransferWarnDays ?? ''}
                    onChange={set('unsettledTransferWarnDays')}
                  />
                </Field>
                <Field label="Default payment file format">
                  <Select
                    value={form.defaultPaymentFileFormat ?? 'PESONET_CSV'}
                    onValueChange={(v) => setForm((p) => ({ ...p, defaultPaymentFileFormat: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYMENT_FILE_FORMATS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {titleCase(f)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Originator name" hint="Written into payment file headers">
                  <Input value={form.originatorName ?? ''} onChange={set('originatorName')} />
                </Field>
                <Field
                  label="Petty cash voucher limit"
                  hint="Above this the approver must differ from the preparer"
                >
                  <Input
                    inputMode="decimal"
                    value={form.pettyCashVoucherLimit ?? ''}
                    onChange={set('pettyCashVoucherLimit')}
                  />
                </Field>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Scenarios</CardTitle>
                <CardDescription>
                  Factors scale forecast inflows / outflows; the delay pushes receipts later.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {SCENARIOS.map((k) => (
                  <div key={k} className="grid gap-2 sm:grid-cols-[6rem_1fr_1fr_1fr] sm:items-end">
                    <div className="pb-2 text-sm font-medium">{titleCase(k)}</div>
                    <Field label="Inflow x">
                      <Input
                        value={scenarios[k]?.inflowFactor ?? ''}
                        onChange={(e) =>
                          setScenarios((p) => ({
                            ...p,
                            [k]: { ...p[k]!, inflowFactor: e.target.value },
                          }))
                        }
                      />
                    </Field>
                    <Field label="Outflow x">
                      <Input
                        value={scenarios[k]?.outflowFactor ?? ''}
                        onChange={(e) =>
                          setScenarios((p) => ({
                            ...p,
                            [k]: { ...p[k]!, outflowFactor: e.target.value },
                          }))
                        }
                      />
                    </Field>
                    <Field label="Delay (days)">
                      <Input
                        inputMode="numeric"
                        value={scenarios[k]?.inflowDelayDays ?? ''}
                        onChange={(e) =>
                          setScenarios((p) => ({
                            ...p,
                            [k]: { ...p[k]!, inflowDelayDays: e.target.value },
                          }))
                        }
                      />
                    </Field>
                  </div>
                ))}
                <div className="text-xs text-muted-foreground">
                  Collection probabilities per aging bucket:{' '}
                  {Object.entries(s.collectionProbabilities)
                    .map(([k, v]) => `${k} ${Math.round(Number(v) * 100)}%`)
                    .join(', ')}
                </div>
                <Can permissions={[P['treasury-settings.manage']]}>
                  <div className="flex justify-end">
                    <Button
                      disabled={update.isPending}
                      onClick={async () => {
                        try {
                          await update.mutateAsync({
                            forecastHorizonDays: Number(form.forecastHorizonDays),
                            forecastGranularity: form.forecastGranularity as ForecastGranularity,
                            minimumDaysCashOnHand: Number(form.minimumDaysCashOnHand),
                            burnWindowDays: Number(form.burnWindowDays),
                            transferApprovalThreshold: form.transferApprovalThreshold
                              ? form.transferApprovalThreshold
                              : null,
                            unsettledTransferWarnDays: Number(form.unsettledTransferWarnDays),
                            defaultPaymentFileFormat:
                              form.defaultPaymentFileFormat as PaymentFileFormat,
                            originatorName: form.originatorName || undefined,
                            pettyCashVoucherLimit: form.pettyCashVoucherLimit
                              ? form.pettyCashVoucherLimit
                              : null,
                            scenarios: Object.fromEntries(
                              SCENARIOS.map((k) => [
                                k,
                                {
                                  inflowFactor: scenarios[k]!.inflowFactor,
                                  outflowFactor: scenarios[k]!.outflowFactor,
                                  inflowDelayDays: Number(scenarios[k]!.inflowDelayDays),
                                },
                              ]),
                            ),
                          });
                          toast.success('Treasury settings saved.');
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      Save settings
                    </Button>
                  </div>
                </Can>
              </CardContent>
            </Card>
            <div className="lg:col-span-2">
              <ProfilesCard />
            </div>
            <div className="lg:col-span-2">
              <IntegrityCard />
            </div>
          </div>
        )}
      </QueryState>
    </>
  );
}

function ProfilesCard() {
  const banks = useBankAccounts();
  const [editing, setEditing] = React.useState<BankAccount | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Bank account profiles</CardTitle>
        <CardDescription>
          Account type, minimum / target balances, overdraft line, routing and payment file details,
          and which account is the default for receipts and payments.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>GL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(banks.data ?? []).map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <div className="font-medium">{b.code}</div>
                  <div className="text-xs text-muted-foreground">
                    {b.bankName ?? b.name} {b.accountNumber ?? ''}
                  </div>
                </TableCell>
                <TableCell>{b.currency}</TableCell>
                <TableCell className="text-xs">
                  {b.glAccountCode} {b.glAccountName}
                </TableCell>
                <TableCell>
                  <StatusBadge status={b.status} />
                </TableCell>
                <TableCell className="text-right">
                  <Can permissions={[P['treasury-settings.manage']]}>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(b)}>
                      <Pencil /> Profile
                    </Button>
                  </Can>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      <ProfileDialog account={editing} onOpenChange={(o) => !o && setEditing(null)} />
    </Card>
  );
}

function ProfileDialog({
  account,
  onOpenChange,
}: {
  account: BankAccount | null;
  onOpenChange: (o: boolean) => void;
}) {
  const profile = useBankAccountProfile(account?.id ?? null);
  const update = useUpdateBankAccountProfile();
  const p = profile.data;
  const [form, setForm] = React.useState<Record<string, string>>({});
  const [flags, setFlags] = React.useState({
    isDefaultReceipts: false,
    isDefaultPayments: false,
    excludeFromPosition: false,
  });
  React.useEffect(() => {
    if (!p) return;
    setForm({
      accountType: p.accountType,
      purpose: p.purpose ?? '',
      minimumBalance: p.minimumBalance ?? '',
      targetBalance: p.targetBalance ?? '',
      overdraftLimit: p.overdraftLimit ?? '',
      routingCode: p.routingCode ?? '',
      paymentFileFormat: p.paymentFileFormat ?? 'NONE',
      originatorId: p.originatorId ?? '',
      signatories: p.signatories ?? '',
    });
    setFlags({
      isDefaultReceipts: p.isDefaultReceipts,
      isDefaultPayments: p.isDefaultPayments,
      excludeFromPosition: p.excludeFromPosition,
    });
  }, [p]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [k]: e.target.value }));
  return (
    <Dialog open={Boolean(account)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{account?.code} treasury profile</DialogTitle>
          <DialogDescription>
            Limits drive the cash position warnings and the liquidity floor; routing and originator
            details go into payment files.
          </DialogDescription>
        </DialogHeader>
        {!p ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account type">
              <Select
                value={form.accountType ?? 'CURRENT'}
                onValueChange={(v) => setForm((prev) => ({ ...prev, accountType: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BANK_ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Purpose">
              <Input value={form.purpose ?? ''} onChange={set('purpose')} />
            </Field>
            <Field label="Minimum balance">
              <Input
                inputMode="decimal"
                value={form.minimumBalance ?? ''}
                onChange={set('minimumBalance')}
                aria-label="Minimum balance"
              />
            </Field>
            <Field label="Target balance">
              <Input
                inputMode="decimal"
                value={form.targetBalance ?? ''}
                onChange={set('targetBalance')}
              />
            </Field>
            <Field label="Overdraft limit">
              <Input
                inputMode="decimal"
                value={form.overdraftLimit ?? ''}
                onChange={set('overdraftLimit')}
              />
            </Field>
            <Field label="Routing / BIC">
              <Input value={form.routingCode ?? ''} onChange={set('routingCode')} />
            </Field>
            <Field label="Payment file format">
              <Select
                value={form.paymentFileFormat ?? 'NONE'}
                onValueChange={(v) => setForm((prev) => ({ ...prev, paymentFileFormat: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">Company default</SelectItem>
                  {PAYMENT_FILE_FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {titleCase(f)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Originator ID">
              <Input value={form.originatorId ?? ''} onChange={set('originatorId')} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Signatories">
                <Input value={form.signatories ?? ''} onChange={set('signatories')} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={flags.isDefaultReceipts}
                onCheckedChange={(v) => setFlags((f) => ({ ...f, isDefaultReceipts: v === true }))}
              />{' '}
              Default for receipts
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={flags.isDefaultPayments}
                onCheckedChange={(v) => setFlags((f) => ({ ...f, isDefaultPayments: v === true }))}
              />{' '}
              Default for payments
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox
                checked={flags.excludeFromPosition}
                onCheckedChange={(v) =>
                  setFlags((f) => ({ ...f, excludeFromPosition: v === true }))
                }
              />{' '}
              Exclude from the cash position (trust / escrow)
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!p || update.isPending}
            onClick={async () => {
              try {
                await update.mutateAsync({
                  bankAccountId: account!.id,
                  accountType: form.accountType as BankAccountType,
                  purpose: form.purpose || undefined,
                  minimumBalance: form.minimumBalance ? form.minimumBalance : null,
                  targetBalance: form.targetBalance ? form.targetBalance : null,
                  overdraftLimit: form.overdraftLimit ? form.overdraftLimit : null,
                  routingCode: form.routingCode || undefined,
                  paymentFileFormat:
                    form.paymentFileFormat === 'NONE'
                      ? null
                      : (form.paymentFileFormat as PaymentFileFormat),
                  originatorId: form.originatorId || undefined,
                  signatories: form.signatories || undefined,
                  ...flags,
                });
                toast.success(`${account!.code} profile saved.`);
                onOpenChange(false);
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            Save profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IntegrityCard() {
  const [asOf, setAsOf] = React.useState(today());
  const report = useTreasuryIntegrity(asOf);
  const r = report.data;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="size-4" /> Treasury integrity{' '}
            {r ? <StatusBadge status={r.status} /> : null}
          </CardTitle>
          <CardDescription>
            Cash in transit equals open transfers, petty cash reconciles to its imprest, payment
            files equal their payments, statements are explained by the books.
          </CardDescription>
        </div>
        <Input
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          className="w-40"
          aria-label="Integrity as of"
        />
      </CardHeader>
      <CardContent className="p-0">
        {!r ? (
          <Skeleton className="m-4 h-40" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Check</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead className="text-right">Findings</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.findings.map((f) => (
                <TableRow
                  key={f.check}
                  className={
                    f.count
                      ? f.severity === 'CRITICAL'
                        ? 'bg-critical/5'
                        : 'bg-warning/5'
                      : undefined
                  }
                >
                  <TableCell>
                    <div className="text-sm">{f.title}</div>
                    <div className="font-mono text-xs text-muted-foreground">{f.check}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={f.count ? f.severity : 'OK'} />
                  </TableCell>
                  <TableCell className="text-right">{f.count}</TableCell>
                  <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                    {f.detail ?? (f.samples[0] ? JSON.stringify(f.samples[0]) : '')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
