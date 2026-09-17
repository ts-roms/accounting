'use client';
import * as React from 'react';
import Link from 'next/link';
import { Check, Inbox, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatMoney } from '@accounting/money';
import type { BankFeedAction, BankSuggestionSource, BankTransactionType } from '@accounting/types';
import { P } from '@accounting/types';
import {
  Badge,
  Button,
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
  useApplyBankSuggestion,
  useBankFeedQueue,
  useDismissBankSuggestion,
  useExplainBankLine,
  useSuggestBankFeed,
} from '@/lib/api/bank-feed-hooks';
import type { BankSuggestion, FeedQueueLine } from '@/lib/api/bank-feed-types';
import { AP_CONFIG, AR_CONFIG } from '@/lib/subledger/config';
import { formatDate } from '@/lib/format';
import { AccountCombobox, Amount } from '@/components/accounting/primitives';
import { BankAccountSelect } from '@/components/banking/shared';
import { PartyCombobox } from '@/components/subledger/party-combobox';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Field } from '@/components/receivables/shared';
import type { ColumnDef } from '@tanstack/react-table';

export const ACTION_LABEL: Record<BankFeedAction, string> = {
  POST_TRANSACTION: 'Bank transaction',
  RECEIVE_CUSTOMER: 'Customer receipt',
  PAY_VENDOR: 'Vendor payment',
  IGNORE: 'Ignore',
};
const SOURCE_LABEL: Record<BankSuggestionSource, string> = {
  RULE: 'Rule',
  DOCUMENT: 'Open document',
  HISTORY: 'History',
  MANUAL: 'Manual',
};
const CONFIDENCE_VARIANT = { HIGH: 'success', MEDIUM: 'warning', LOW: 'secondary' } as const;

function describeSuggestion(s: BankSuggestion): string {
  const p = s.payload;
  switch (s.action) {
    case 'POST_TRANSACTION':
      return `${p.transactionType ? p.transactionType.toLowerCase().replace('_', ' ') : 'transaction'}${p.memo ? ` - ${p.memo}` : ''}`;
    case 'RECEIVE_CUSTOMER':
    case 'PAY_VENDOR':
      return `${p.partyName ?? ''}${p.allocations?.length ? ` -> ${p.allocations.map((a) => a.documentNumber || 'document').join(', ')}` : ''}`;
    case 'IGNORE':
      return 'no ledger entry';
  }
}

/** Unexplained feed lines with their suggestions: accept, adjust, dismiss or explain by hand. */
export function BankFeedQueuePage() {
  const table = useTableState({ pageSize: 50 });
  const [bankAccountId, setBankAccountId] = React.useState<string | null>(null);
  const [suggested, setSuggested] = React.useState('ALL');
  const [explaining, setExplaining] = React.useState<FeedQueueLine | null>(null);
  const [adjusting, setAdjusting] = React.useState<{
    line: FeedQueueLine;
    suggestion: BankSuggestion;
  } | null>(null);
  const queue = useBankFeedQueue({
    ...table.query,
    bankAccountId: bankAccountId ?? undefined,
    suggested: suggested === 'ALL' ? undefined : (suggested as 'YES' | 'NO'),
  });
  const suggest = useSuggestBankFeed();
  const apply = useApplyBankSuggestion();
  const dismiss = useDismissBankSuggestion();
  const columns = React.useMemo<ColumnDef<FeedQueueLine>[]>(
    () => [
      {
        id: 'line',
        header: 'Feed line',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="max-w-md">
            <div className="text-sm">{row.original.description}</div>
            <div className="text-xs text-muted-foreground">
              {formatDate(row.original.lineDate)} - {row.original.bankAccountCode} -{' '}
              {row.original.statementNumber}
              {row.original.reference ? ` - ref ${row.original.reference}` : ''} -{' '}
              {row.original.ageDays}d
            </div>
          </div>
        ),
      },
      {
        id: 'amount',
        header: () => <span className="block text-right">Amount</span>,
        enableSorting: false,
        cell: ({ row }) => (
          <Amount
            value={row.original.amount}
            currency={row.original.currency}
            className={Number(row.original.amount) < 0 ? 'text-critical' : 'text-positive'}
          />
        ),
      },
      {
        id: 'suggestions',
        header: 'Suggestions',
        enableSorting: false,
        cell: ({ row }) => (
          <div className="space-y-1.5">
            {row.original.suggestions.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                {row.original.status === 'POSSIBLE_MATCH' || row.original.status === 'EXCEPTION'
                  ? 'Ledger candidates - see Bank Reconciliation'
                  : 'None - explain by hand'}
              </span>
            ) : (
              row.original.suggestions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center gap-1.5"
                  data-testid="feed-suggestion"
                >
                  <Badge variant={CONFIDENCE_VARIANT[s.confidence]} className="text-[10px]">
                    {s.confidence}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {SOURCE_LABEL[s.source]}
                    {s.ruleName ? `: ${s.ruleName}` : ''}
                  </Badge>
                  <span className="text-xs">
                    <span className="font-medium">{ACTION_LABEL[s.action]}</span>{' '}
                    {describeSuggestion(s)}
                  </span>
                  <Can permissions={[P['bank-feed.manage']]}>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 px-2"
                      disabled={apply.isPending}
                      data-testid="suggestion-apply"
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          const r = await apply.mutateAsync({ id: s.id });
                          toast.success(`Explained by ${r.resultNumber ?? 'ignore'}`);
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      <Check /> Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAdjusting({ line: row.original, suggestion: s });
                      }}
                    >
                      Adjust
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      aria-label="Dismiss suggestion"
                      disabled={dismiss.isPending}
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await dismiss.mutateAsync(s.id);
                        } catch (err) {
                          toast.error(describeError(err));
                        }
                      }}
                    >
                      <X />
                    </Button>
                  </Can>
                </div>
              ))
            )}
          </div>
        ),
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => (
          <Can permissions={[P['bank-feed.manage']]}>
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                setExplaining(row.original);
              }}
              data-testid="line-explain"
            >
              Explain
            </Button>
          </Can>
        ),
      },
    ],
    [apply, dismiss],
  );
  return (
    <>
      <PageHeader
        title="Bank Feed Review"
        description="Statement lines nothing in the ledger explains yet. Rules, open invoices and bills, and past explanations propose what to post; accepting posts the document through its own module and matches the line."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/banking/feed/rules">Rules</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/banking/feed/dashboard">KPIs</Link>
            </Button>
            <Can permissions={[P['bank-feed.manage']]}>
              <Button
                size="sm"
                disabled={suggest.isPending}
                data-testid="feed-refresh"
                onClick={async () => {
                  try {
                    const s = await suggest.mutateAsync({});
                    toast.success(
                      `${s.suggested} line(s) suggested, ${s.autoApplied} explained by rules${s.failed ? `, ${s.failed} failed` : ''}`,
                    );
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                <Sparkles /> Refresh suggestions
              </Button>
            </Can>
          </div>
        }
      />
      <DataTable
        columns={columns}
        data={queue.data}
        isLoading={queue.isLoading}
        isFetching={queue.isFetching}
        pagination={table.pagination}
        getRowId={(r) => r.id}
        emptyState={
          <EmptyState
            icon={Inbox}
            title="Nothing to review"
            description="Every imported line is explained. Import a statement or wait for the next feed sync."
          />
        }
        toolbar={
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={table.search}
                onChange={(e) => table.setSearch(e.target.value)}
                placeholder="Description, reference"
                className="w-64 pl-8"
                aria-label="Search lines"
              />
            </div>
            <BankAccountSelect
              value={bankAccountId}
              onChange={(id) => {
                setBankAccountId(id);
                table.resetPage();
              }}
              allowAll="All bank accounts"
              className="w-52"
            />
            <Select
              value={suggested}
              onValueChange={(v) => {
                setSuggested(v);
                table.resetPage();
              }}
            >
              <SelectTrigger className="w-44" aria-label="Suggestions">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All lines</SelectItem>
                <SelectItem value="YES">With suggestions</SelectItem>
                <SelectItem value="NO">Without suggestions</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reload"
              onClick={() => void queue.refetch()}
            >
              <RefreshCw />
            </Button>
          </>
        }
      />
      <ExplainDialog line={explaining} onClose={() => setExplaining(null)} />
      <ExplainDialog
        line={adjusting?.line ?? null}
        suggestion={adjusting?.suggestion ?? null}
        onClose={() => setAdjusting(null)}
      />
    </>
  );
}

/** Explain a line by hand, or adjust a suggestion before applying it. */
function ExplainDialog({
  line,
  suggestion,
  onClose,
}: {
  line: FeedQueueLine | null;
  suggestion?: BankSuggestion | null;
  onClose: () => void;
}) {
  const explain = useExplainBankLine();
  const apply = useApplyBankSuggestion();
  const inbound = line ? Number(line.amount) >= 0 : true;
  const [form, setForm] = React.useState({
    action: 'POST_TRANSACTION' as BankFeedAction,
    transactionType: 'DEPOSIT' as BankTransactionType,
    counterpartyAccountId: null as string | null,
    partyId: null as string | null,
    memo: '',
    note: '',
  });
  React.useEffect(() => {
    if (!line) return;
    const p = suggestion?.payload;
    setForm({
      action: p?.action ?? 'POST_TRANSACTION',
      transactionType:
        (p?.transactionType as BankTransactionType | undefined) ??
        (inbound ? 'DEPOSIT' : 'WITHDRAWAL'),
      counterpartyAccountId: p?.counterpartyAccountId ?? null,
      partyId: p?.partyId ?? null,
      memo: p?.memo ?? '',
      note: '',
    });
  }, [line, suggestion, inbound]);
  if (!line) return null;
  const pending = explain.isPending || apply.isPending;
  const submit = async () => {
    try {
      if (suggestion) {
        const r = await apply.mutateAsync({
          id: suggestion.id,
          action: form.action,
          transactionType: form.action === 'POST_TRANSACTION' ? form.transactionType : undefined,
          counterpartyAccountId: form.counterpartyAccountId,
          partyId: form.partyId,
          memo: form.memo || undefined,
        });
        toast.success(`Explained by ${r.resultNumber ?? 'ignore'}`);
      } else {
        const r = await explain.mutateAsync({
          lineId: line.id,
          action: form.action,
          transactionType: form.action === 'POST_TRANSACTION' ? form.transactionType : undefined,
          counterpartyAccountId: form.counterpartyAccountId,
          partyId: form.partyId,
          memo: form.memo || undefined,
          note: form.note || undefined,
        });
        toast.success(`Explained by ${r.resultNumber ?? 'ignore'}`);
      }
      onClose();
    } catch (err) {
      toast.error(describeError(err));
    }
  };
  const canSubmit =
    form.action === 'IGNORE' ||
    (form.action === 'POST_TRANSACTION'
      ? Boolean(form.counterpartyAccountId)
      : Boolean(form.partyId));
  return (
    <Dialog open={Boolean(line)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{suggestion ? 'Adjust and apply' : 'Explain feed line'}</DialogTitle>
          <DialogDescription>
            {formatDate(line.lineDate)} - {line.description} -{' '}
            {formatMoney(line.amount, line.currency)}. The document posts through its own module and
            the line is matched to it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="What explains it">
            <Select
              value={form.action}
              onValueChange={(v) => setForm((f) => ({ ...f, action: v as BankFeedAction }))}
            >
              <SelectTrigger aria-label="Action" data-testid="explain-action">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="POST_TRANSACTION">
                  {ACTION_LABEL.POST_TRANSACTION} (fee, interest, deposit, withdrawal)
                </SelectItem>
                {inbound ? (
                  <SelectItem value="RECEIVE_CUSTOMER">{ACTION_LABEL.RECEIVE_CUSTOMER}</SelectItem>
                ) : (
                  <SelectItem value="PAY_VENDOR">{ACTION_LABEL.PAY_VENDOR}</SelectItem>
                )}
                <SelectItem value="IGNORE">
                  {ACTION_LABEL.IGNORE} - no ledger entry needed
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {form.action === 'POST_TRANSACTION' ? (
            <>
              <Field label="Type">
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
                    {(inbound ? ['DEPOSIT', 'INTEREST'] : ['WITHDRAWAL', 'BANK_FEE']).map((t) => (
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
            <Field
              label={form.action === 'RECEIVE_CUSTOMER' ? 'Customer' : 'Vendor'}
              hint="Allocated to the suggested documents, otherwise left on account"
            >
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
          {!suggestion ? (
            <Field label="Note">
              <Textarea
                rows={2}
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              />
            </Field>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !canSubmit}
            data-testid="explain-confirm"
          >
            {suggestion ? 'Apply' : 'Explain and post'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
