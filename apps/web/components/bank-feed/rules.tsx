'use client';
import * as React from 'react';
import Link from 'next/link';
import { FlaskConical, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type {
  BankFeedAction,
  BankRuleDirection,
  BankRuleMatchMode,
  BankTransactionType,
} from '@accounting/types';
import { P } from '@accounting/types';
import {
  Badge,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useBankFeedSettings,
  useBankMatchingRules,
  useCreateBankMatchingRule,
  useDeleteBankMatchingRule,
  useTestBankMatchingRule,
  useUpdateBankFeedSettings,
  useUpdateBankMatchingRule,
} from '@/lib/api/bank-feed-hooks';
import type { BankMatchingRule, RuleTestResult } from '@/lib/api/bank-feed-types';
import { AP_CONFIG, AR_CONFIG } from '@/lib/subledger/config';
import { formatDate, formatDateTime } from '@/lib/format';
import { AccountCombobox } from '@/components/accounting/primitives';
import { BankAccountSelect } from '@/components/banking/shared';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { Field, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';
import { ACTION_LABEL } from './queue';

const MODE_LABEL: Record<BankRuleMatchMode, string> = {
  CONTAINS: 'contains',
  STARTS_WITH: 'starts with',
  REGEX: 'matches regex',
};

function conditions(r: BankMatchingRule): string {
  const parts: string[] = [];
  if (r.direction !== 'ANY') parts.push(r.direction === 'IN' ? 'money in' : 'money out');
  if (r.descriptionPattern)
    parts.push(`description ${MODE_LABEL[r.descriptionMode]} "${r.descriptionPattern}"`);
  if (r.referencePattern)
    parts.push(`reference ${MODE_LABEL[r.referenceMode]} "${r.referencePattern}"`);
  if (r.amountMin || r.amountMax)
    parts.push(
      `amount ${r.amountMin ? `>= ${Number(r.amountMin).toLocaleString()}` : ''}${r.amountMin && r.amountMax ? ' and ' : ''}${r.amountMax ? `<= ${Number(r.amountMax).toLocaleString()}` : ''}`,
    );
  if (r.bankAccountCode) parts.push(`on ${r.bankAccountCode}`);
  return parts.join(', ');
}

function outcome(r: BankMatchingRule): string {
  switch (r.action) {
    case 'POST_TRANSACTION':
      return `${(r.transactionType ?? '').toLowerCase().replace('_', ' ')} -> ${r.counterpartyAccountCode ?? '?'}${r.memo ? ` "${r.memo}"` : ''}`;
    case 'RECEIVE_CUSTOMER':
      return `receipt from ${r.partyName ?? '?'}`;
    case 'PAY_VENDOR':
      return `payment to ${r.partyName ?? '?'}`;
    case 'IGNORE':
      return 'no ledger entry';
  }
}

/** Matching rules (ordered by priority) and the feed settings. */
export function BankFeedRulesPage() {
  const rules = useBankMatchingRules();
  const settings = useBankFeedSettings();
  const updateSettings = useUpdateBankFeedSettings();
  const remove = useDeleteBankMatchingRule();
  const [editing, setEditing] = React.useState<BankMatchingRule | 'new' | null>(null);
  const [form, setForm] = React.useState({
    autoApplyRules: true,
    autoApplyDocumentMatches: false,
    staleAfterDays: '7',
    historyMinOccurrences: '2',
  });
  React.useEffect(() => {
    if (settings.data)
      setForm({
        autoApplyRules: settings.data.autoApplyRules,
        autoApplyDocumentMatches: settings.data.autoApplyDocumentMatches,
        staleAfterDays: String(settings.data.staleAfterDays),
        historyMinOccurrences: String(settings.data.historyMinOccurrences),
      });
  }, [settings.data]);
  return (
    <>
      <PageHeader
        title="Bank Feed Rules"
        description="What a feed line looks like -> what explains it. Rules run in priority order; a rule flagged auto-apply posts without review when the settings allow it."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/banking/feed">Review queue</Link>
            </Button>
            <Can permissions={[P['bank-feed.manage']]}>
              <Button size="sm" onClick={() => setEditing('new')} data-testid="rule-new">
                <Plus /> New rule
              </Button>
            </Can>
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Rules</CardTitle>
            <CardDescription>Hit counts show how often each rule explained a line.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <QueryState query={rules}>
              {(rows) => (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>#</TableHead>
                      <TableHead>Rule</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Then</TableHead>
                      <TableHead>Auto</TableHead>
                      <TableHead>Hits</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                          No rules yet - the feed still suggests open documents and past
                          explanations.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((r) => (
                        <TableRow key={r.id} data-testid="feed-rule-row">
                          <TableCell className="font-mono text-xs">{r.priority}</TableCell>
                          <TableCell>
                            <div>{r.name}</div>
                            {r.description ? (
                              <div className="text-xs text-muted-foreground">{r.description}</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-xs">{conditions(r)}</TableCell>
                          <TableCell className="text-xs">
                            <Badge variant="outline" className="mr-1 text-[10px]">
                              {ACTION_LABEL[r.action]}
                            </Badge>
                            {outcome(r)}
                          </TableCell>
                          <TableCell>{r.autoApply ? 'Yes' : 'No'}</TableCell>
                          <TableCell className="text-xs">
                            {r.hitCount}
                            {r.lastHitAt ? (
                              <div className="text-muted-foreground">
                                {formatDateTime(r.lastHitAt)}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={r.status} />
                          </TableCell>
                          <TableCell className="text-right whitespace-nowrap">
                            <Can permissions={[P['bank-feed.manage']]}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${r.name}`}
                                onClick={() => setEditing(r)}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${r.name}`}
                                onClick={async () => {
                                  try {
                                    await remove.mutateAsync(r.id);
                                  } catch (err) {
                                    toast.error(describeError(err));
                                  }
                                }}
                              >
                                <Trash2 />
                              </Button>
                            </Can>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </QueryState>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Settings</CardTitle>
            <CardDescription>What may post without a person confirming.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <QueryState query={settings}>
              {() => (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.autoApplyRules}
                      onCheckedChange={(v) =>
                        setForm((f) => ({ ...f, autoApplyRules: v === true }))
                      }
                      aria-label="Auto-apply rules"
                    />{' '}
                    Auto-apply rules flagged for it
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.autoApplyDocumentMatches}
                      onCheckedChange={(v) =>
                        setForm((f) => ({ ...f, autoApplyDocumentMatches: v === true }))
                      }
                      aria-label="Auto-apply document matches"
                    />{' '}
                    Auto-apply HIGH-confidence invoice / bill matches
                  </label>
                  <Field label="Flag lines as stale after (days)">
                    <Input
                      inputMode="numeric"
                      value={form.staleAfterDays}
                      onChange={(e) => setForm((f) => ({ ...f, staleAfterDays: e.target.value }))}
                    />
                  </Field>
                  <Field label="History needs this many past explanations for MEDIUM confidence">
                    <Input
                      inputMode="numeric"
                      value={form.historyMinOccurrences}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, historyMinOccurrences: e.target.value }))
                      }
                    />
                  </Field>
                  <Can permissions={[P['bank-feed.manage']]}>
                    <Button
                      size="sm"
                      disabled={updateSettings.isPending}
                      onClick={async () => {
                        try {
                          await updateSettings.mutateAsync({
                            autoApplyRules: form.autoApplyRules,
                            autoApplyDocumentMatches: form.autoApplyDocumentMatches,
                            staleAfterDays: Number(form.staleAfterDays || 7),
                            historyMinOccurrences: Number(form.historyMinOccurrences || 2),
                          });
                          toast.success('Bank feed settings saved');
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      Save settings
                    </Button>
                  </Can>
                </>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </div>
      <RuleDialog editing={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function RuleDialog({
  editing,
  onClose,
}: {
  editing: BankMatchingRule | 'new' | null;
  onClose: () => void;
}) {
  const create = useCreateBankMatchingRule();
  const update = useUpdateBankMatchingRule();
  const test = useTestBankMatchingRule();
  const isNew = editing === 'new';
  const existing = editing && editing !== 'new' ? editing : null;
  const [result, setResult] = React.useState<RuleTestResult | null>(null);
  const [form, setForm] = React.useState({
    name: '',
    description: '',
    priority: '100',
    bankAccountId: null as string | null,
    direction: 'ANY' as BankRuleDirection,
    descriptionPattern: '',
    descriptionMode: 'CONTAINS' as BankRuleMatchMode,
    referencePattern: '',
    referenceMode: 'CONTAINS' as BankRuleMatchMode,
    amountMin: '',
    amountMax: '',
    action: 'POST_TRANSACTION' as BankFeedAction,
    transactionType: 'BANK_FEE' as BankTransactionType,
    counterpartyAccountId: null as string | null,
    partyId: null as string | null,
    memo: '',
    autoApply: false,
    status: 'ACTIVE',
  });
  React.useEffect(() => {
    if (!editing) return;
    setResult(null);
    setForm({
      name: existing?.name ?? '',
      description: existing?.description ?? '',
      priority: String(existing?.priority ?? 100),
      bankAccountId: existing?.bankAccountId ?? null,
      direction: existing?.direction ?? 'ANY',
      descriptionPattern: existing?.descriptionPattern ?? '',
      descriptionMode: existing?.descriptionMode ?? 'CONTAINS',
      referencePattern: existing?.referencePattern ?? '',
      referenceMode: existing?.referenceMode ?? 'CONTAINS',
      amountMin: existing?.amountMin ? String(Number(existing.amountMin)) : '',
      amountMax: existing?.amountMax ? String(Number(existing.amountMax)) : '',
      action: existing?.action ?? 'POST_TRANSACTION',
      transactionType: existing?.transactionType ?? 'BANK_FEE',
      counterpartyAccountId: existing?.counterpartyAccountId ?? null,
      partyId: existing?.partyId ?? null,
      memo: existing?.memo ?? '',
      autoApply: existing?.autoApply ?? false,
      status: existing?.status ?? 'ACTIVE',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const payload = () => ({
    name: form.name,
    description: form.description || undefined,
    priority: Number(form.priority || 100),
    bankAccountId: form.bankAccountId,
    direction: form.direction,
    descriptionPattern: form.descriptionPattern || null,
    descriptionMode: form.descriptionMode,
    referencePattern: form.referencePattern || null,
    referenceMode: form.referenceMode,
    amountMin: form.amountMin || null,
    amountMax: form.amountMax || null,
    action: form.action,
    transactionType: form.action === 'POST_TRANSACTION' ? form.transactionType : undefined,
    counterpartyAccountId: form.action === 'POST_TRANSACTION' ? form.counterpartyAccountId : null,
    partyId:
      form.action === 'RECEIVE_CUSTOMER' || form.action === 'PAY_VENDOR' ? form.partyId : null,
    memo: form.memo || undefined,
    autoApply: form.autoApply,
  });
  const pending = create.isPending || update.isPending;
  const submit = async () => {
    try {
      if (isNew) await create.mutateAsync(payload());
      else if (existing)
        await update.mutateAsync({
          id: existing.id,
          ...payload(),
          status: form.status as BankMatchingRule['status'],
        });
      toast.success(isNew ? 'Rule created' : 'Rule updated');
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  return (
    <Dialog open={Boolean(editing)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New matching rule' : `Edit ${existing?.name}`}</DialogTitle>
          <DialogDescription>
            Every condition must hold. Test the draft against the unexplained lines before saving.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              data-testid="rule-name"
            />
          </Field>
          <Field label="Priority (lower runs first)">
            <Input
              inputMode="numeric"
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
            />
          </Field>
          <Field label="Bank account">
            <BankAccountSelect
              value={form.bankAccountId}
              onChange={(id) => setForm((f) => ({ ...f, bankAccountId: id }))}
              allowAll="Any bank account"
            />
          </Field>
          <Field label="Direction">
            <Select
              value={form.direction}
              onValueChange={(v) => setForm((f) => ({ ...f, direction: v as BankRuleDirection }))}
            >
              <SelectTrigger aria-label="Direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ANY">Any</SelectItem>
                <SelectItem value="IN">Money in</SelectItem>
                <SelectItem value="OUT">Money out</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Description pattern">
            <div className="flex gap-1">
              <Select
                value={form.descriptionMode}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, descriptionMode: v as BankRuleMatchMode }))
                }
              >
                <SelectTrigger className="w-36" aria-label="Description mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MODE_LABEL) as BankRuleMatchMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODE_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={form.descriptionPattern}
                onChange={(e) => setForm((f) => ({ ...f, descriptionPattern: e.target.value }))}
                data-testid="rule-description"
              />
            </div>
          </Field>
          <Field label="Reference pattern">
            <div className="flex gap-1">
              <Select
                value={form.referenceMode}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, referenceMode: v as BankRuleMatchMode }))
                }
              >
                <SelectTrigger className="w-36" aria-label="Reference mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(MODE_LABEL) as BankRuleMatchMode[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {MODE_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={form.referencePattern}
                onChange={(e) => setForm((f) => ({ ...f, referencePattern: e.target.value }))}
              />
            </div>
          </Field>
          <Field label="Amount from">
            <Input
              inputMode="decimal"
              value={form.amountMin}
              onChange={(e) => setForm((f) => ({ ...f, amountMin: e.target.value }))}
            />
          </Field>
          <Field label="Amount to">
            <Input
              inputMode="decimal"
              value={form.amountMax}
              onChange={(e) => setForm((f) => ({ ...f, amountMax: e.target.value }))}
            />
          </Field>
          <Field label="Then">
            <Select
              value={form.action}
              onValueChange={(v) => setForm((f) => ({ ...f, action: v as BankFeedAction }))}
            >
              <SelectTrigger aria-label="Action" data-testid="rule-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ACTION_LABEL) as BankFeedAction[]).map((a) => (
                  <SelectItem key={a} value={a}>
                    {ACTION_LABEL[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {form.action === 'POST_TRANSACTION' ? (
            <>
              <Field label="Transaction type">
                <Select
                  value={form.transactionType}
                  onValueChange={(v) =>
                    setForm((f) => ({ ...f, transactionType: v as BankTransactionType }))
                  }
                >
                  <SelectTrigger aria-label="Transaction type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['DEPOSIT', 'INTEREST', 'WITHDRAWAL', 'BANK_FEE'].map((t) => (
                      <SelectItem key={t} value={t}>
                        {t.replace('_', ' ').toLowerCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Counterparty account">
                <AccountCombobox
                  value={form.counterpartyAccountId}
                  onChange={(id) => setForm((f) => ({ ...f, counterpartyAccountId: id }))}
                />
              </Field>
            </>
          ) : null}
          {form.action === 'RECEIVE_CUSTOMER' || form.action === 'PAY_VENDOR' ? (
            <Field label={form.action === 'RECEIVE_CUSTOMER' ? 'Customer' : 'Vendor'}>
              <PartyCombobox
                cfg={form.action === 'RECEIVE_CUSTOMER' ? AR_CONFIG : AP_CONFIG}
                value={form.partyId}
                onChange={(id) => setForm((f) => ({ ...f, partyId: id }))}
              />
            </Field>
          ) : null}
          <Field label="Memo">
            <Input
              value={form.memo}
              onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))}
            />
          </Field>
          {!isNew ? (
            <Field label="Status">
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}
              >
                <SelectTrigger aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox
              checked={form.autoApply}
              onCheckedChange={(v) => setForm((f) => ({ ...f, autoApply: v === true }))}
            />{' '}
            Apply automatically (posts without review)
          </label>
          {result ? (
            <div
              className="rounded-md border p-2 text-xs sm:col-span-2"
              data-testid="rule-test-result"
            >
              <div className="font-medium">
                {result.matched} of {result.total} unexplained line(s) match
              </div>
              {result.lines.slice(0, 5).map((l) => (
                <div key={l.id} className="text-muted-foreground">
                  {formatDate(l.lineDate)} - {l.description} - {l.amount}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={test.isPending}
            data-testid="rule-test"
            onClick={async () => {
              try {
                setResult(await test.mutateAsync(payload()));
              } catch (err) {
                toast.error(describeError(err));
              }
            }}
          >
            <FlaskConical /> Test
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !form.name}
            data-testid="rule-save"
          >
            {isNew ? 'Create rule' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
