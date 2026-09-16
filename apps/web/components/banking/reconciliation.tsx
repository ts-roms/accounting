'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Money } from '@accounting/money';
import { P, STATEMENT_LINE_STATUSES } from '@accounting/types';
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
  Textarea,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import {
  useBankAccount,
  useCompleteReconciliation,
  useReconciliation,
  useRematchStatement,
  useStatementLedgerLines,
  useStatementLineAction,
  useStatementLines,
} from '@/lib/api/assets-banking-hooks';
import type { BankLedgerLine, BankStatementLine } from '@/lib/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';
import { ReconciliationCounters } from './reconciliation-counters';
import { LineStatusBadge, RECONCILIATION_PATH, StatementStatusBadge } from './shared';
import { TransactionDialog } from './transactions';

const signedLedger = (l: BankLedgerLine, currency: string) =>
  Money.of(l.debit, currency).subtract(Money.of(l.credit, currency)).toString();

export function ReconciliationPage({ id }: { id: string }) {
  const { hasPermission } = useSession();
  const view = useReconciliation(id);
  const bank = useBankAccount(view.data?.statement.bankAccountId ?? null);
  const currency = bank.data?.currency ?? 'PHP';
  const lines = useStatementLines(id);
  const ledger = useStatementLedgerLines(id, true);
  const act = useStatementLineAction();
  const rematch = useRematchStatement();
  const complete = useCompleteReconciliation();
  const [filter, setFilter] = React.useState('OPEN');
  const [matching, setMatching] = React.useState<BankStatementLine | null>(null);
  const [ignoring, setIgnoring] = React.useState<BankStatementLine | null>(null);
  const [recording, setRecording] = React.useState<BankStatementLine | null>(null);
  const [completing, setCompleting] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  if (view.isLoading || !view.data) return <Skeleton className="h-96" />;
  const { statement: s, figures: f, reconciliation: rec, canComplete } = view.data;
  const open = s.status === 'OPEN';
  const canWork = open && hasPermission(P['bank-reconciliation.perform']);
  const canRecord = open && hasPermission(P['bank-transaction.create']);
  const visible = (lines.data ?? []).filter((l) =>
    filter === 'ALL'
      ? true
      : filter === 'OPEN'
        ? l.status === 'UNMATCHED' || l.status === 'EXCEPTION'
        : l.status === filter,
  );
  const outstanding = ledger.data ?? [];

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{s.statementNumber}</span>
            <StatementStatusBadge status={s.status} />
          </span>
        }
        description={`${s.bankAccountCode} · ${s.bankAccountName} · statement ${s.statementDate}${s.fileName ? ` · ${s.fileName}` : ''}`}
        actions={
          <>
            <Button variant="ghost" size="sm" asChild>
              <Link href={RECONCILIATION_PATH}>
                <ArrowLeft /> Statements
              </Link>
            </Button>
            {canWork ? (
              <Button
                variant="outline"
                size="sm"
                disabled={rematch.isPending}
                onClick={async () => {
                  try {
                    const r = await rematch.mutateAsync(s.id);
                    toast.success(`Re-matched: ${r.matchedCount}/${r.lineCount} lines.`);
                  } catch (err) {
                    toast.error(describeError(err));
                  }
                }}
              >
                <RefreshCw /> Re-run matching
              </Button>
            ) : null}
            {canWork ? (
              <Button
                size="sm"
                disabled={!canComplete}
                onClick={() => setCompleting(true)}
                data-testid="complete-reconciliation"
              >
                <CheckCircle2 /> Complete reconciliation
              </Button>
            ) : null}
          </>
        }
      />
      {rec?.status === 'COMPLETED' ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Reconciled {formatDateTime(rec.completedAt)}</AlertTitle>
          <AlertDescription>
            Statement {rec.statementBalance} vs ledger {rec.ledgerBalance}; deposits in transit{' '}
            {rec.depositsInTransit}, outstanding payments {rec.outstandingPayments}.
            {rec.notes ? ` ${rec.notes}` : ''}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Statement balance"
          value={<Amount value={f.statementBalance} className="text-left" />}
        />
        <Stat
          label="Ledger balance"
          value={<Amount value={f.ledgerBalance} className="text-left" />}
          hint={`as of ${s.statementDate}`}
        />
        <Stat
          label="Reconciling items"
          value={
            <span className="text-sm font-normal">
              <div>+ deposits in transit {f.depositsInTransit}</div>
              <div>− outstanding payments {f.outstandingPayments}</div>
            </span>
          }
          hint="Ledger lines the bank has not shown yet"
        />
        <Stat
          label="Difference"
          value={<Amount value={f.difference} className="text-left" zeroAsDash />}
          hint={
            Number(f.unrecordedCredits) || Number(f.unrecordedDebits)
              ? `Unrecorded: in ${f.unrecordedCredits}, out ${f.unrecordedDebits}`
              : canComplete
                ? 'Every line explained'
                : open
                  ? 'Explain the open lines'
                  : undefined
          }
          danger={f.difference !== '0.0000'}
        />
      </div>
      <ReconciliationCounters
        matched={s.matchedCount}
        review={s.exceptionCount}
        unmatched={s.unmatchedCount}
        total={s.lineCount}
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Statement lines</CardTitle>
              <CardDescription>
                {s.matchedCount}/{s.lineCount} matched · {s.exceptionCount} exceptions ·{' '}
                {s.unmatchedCount} unmatched
              </CardDescription>
            </div>
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPEN">Needs attention</SelectItem>
                <SelectItem value="ALL">All lines</SelectItem>
                {STATEMENT_LINE_STATUSES.map((st) => (
                  <SelectItem key={st} value={st}>
                    {titleCase(st)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ledger match</TableHead>
                  {open ? <TableHead className="w-56" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-16" />
                    </TableCell>
                  </TableRow>
                ) : visible.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                      {filter === 'OPEN' ? 'Nothing needs attention.' : 'No lines.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((l) => (
                    <TableRow key={l.id} data-testid="statement-line" data-status={l.status}>
                      <TableCell className="text-muted-foreground">{l.lineNumber}</TableCell>
                      <TableCell className="whitespace-nowrap">{l.lineDate}</TableCell>
                      <TableCell>
                        <div>{l.description}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.reference ? <span className="font-mono">{l.reference} · </span> : null}
                          {l.matchNote?.replace(/ candidates:.*$/, '')}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Amount value={l.amount} />
                      </TableCell>
                      <TableCell>
                        <LineStatusBadge status={l.status} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {l.matchedJournalNumber ? (
                          <>
                            <span className="font-mono">{l.matchedJournalNumber}</span>
                            <span className="ml-1 text-muted-foreground">
                              {l.matchedEntryDate} {l.matchKind === 'AUTO' ? '· auto' : '· manual'}
                            </span>
                          </>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      {open ? (
                        <TableCell className="space-x-1 text-right">
                          {canWork && (l.status === 'UNMATCHED' || l.status === 'EXCEPTION') ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setMatching(l)}
                                data-testid="line-match"
                              >
                                Match
                              </Button>
                              {canRecord ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setRecording(l)}
                                  data-testid="line-record"
                                >
                                  Record
                                </Button>
                              ) : null}
                              <Button size="sm" variant="ghost" onClick={() => setIgnoring(l)}>
                                Ignore
                              </Button>
                            </>
                          ) : null}
                          {canWork && l.status === 'MATCHED' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={act.isPending}
                              onClick={async () => {
                                try {
                                  await act.mutateAsync({
                                    statementId: s.id,
                                    action: 'unmatch',
                                    lineId: l.id,
                                  });
                                } catch (err) {
                                  toast.error(describeError(err));
                                }
                              }}
                            >
                              Unmatch
                            </Button>
                          ) : null}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Not on this statement</CardTitle>
            <CardDescription>
              Posted ledger lines on the bank account up to {s.statementDate} without a match:
              deposits in transit and outstanding payments.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Journal</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstanding.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                      Everything in the ledger is on the statement.
                    </TableCell>
                  </TableRow>
                ) : (
                  outstanding.map((l) => (
                    <TableRow key={l.journalLineId} data-testid="outstanding-line">
                      <TableCell className="whitespace-nowrap">{l.entryDate}</TableCell>
                      <TableCell>
                        <Link
                          href={`/accounting/journal-entries/${l.journalEntryId}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {l.journalNumber}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {l.reference ? <span className="font-mono">{l.reference} · </span> : null}
                          {l.description}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Amount value={signedLedger(l, currency)} currency={currency} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <MatchDialog
        statementId={s.id}
        line={matching}
        candidates={outstanding}
        currency={currency}
        onOpenChange={(o) => !o && setMatching(null)}
      />
      <Dialog open={Boolean(ignoring)} onOpenChange={(o) => !o && setIgnoring(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Ignore line {ignoring?.lineNumber}</DialogTitle>
            <DialogDescription>
              Marks the line as a duplicate / non-item so it no longer blocks completion. Say why.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Note</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIgnoring(null)}>
              Cancel
            </Button>
            <Button
              disabled={notes.trim().length < 3 || act.isPending}
              onClick={async () => {
                try {
                  await act.mutateAsync({
                    statementId: s.id,
                    action: 'ignore',
                    lineId: ignoring!.id,
                    note: notes.trim(),
                  });
                  setIgnoring(null);
                  setNotes('');
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Ignore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {recording ? (
        <TransactionDialog
          open
          onOpenChange={(o) => !o && setRecording(null)}
          defaults={{
            bankAccountId: s.bankAccountId,
            transactionDate: recording.lineDate,
            amount: Money.of(recording.amount, currency).abs().toString(),
            transactionType: Number(recording.amount) > 0 ? 'DEPOSIT' : 'BANK_FEE',
            reference: recording.reference ?? undefined,
            memo: recording.description,
            statementLineId: recording.id,
          }}
        />
      ) : null}
      <Dialog open={completing} onOpenChange={setCompleting}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Complete reconciliation</DialogTitle>
            <DialogDescription>
              Locks every matched line and the transactions behind them. Statement{' '}
              {f.statementBalance} + deposits in transit {f.depositsInTransit} − outstanding
              payments {f.outstandingPayments} = ledger {f.ledgerBalance}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Notes (optional)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompleting(false)}>
              Cancel
            </Button>
            <Button
              disabled={complete.isPending}
              data-testid="confirm-complete"
              onClick={async () => {
                try {
                  await complete.mutateAsync({ id: s.id, notes: notes.trim() || undefined });
                  toast.success('Reconciliation completed.');
                  setCompleting(false);
                  setNotes('');
                } catch (err) {
                  toast.error(describeError(err));
                }
              }}
            >
              Complete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MatchDialog({
  statementId,
  line,
  candidates,
  currency,
  onOpenChange,
}: {
  statementId: string;
  line: BankStatementLine | null;
  candidates: BankLedgerLine[];
  currency: string;
  onOpenChange: (open: boolean) => void;
}) {
  const act = useStatementLineAction();
  const [showAll, setShowAll] = React.useState(false);
  const [search, setSearch] = React.useState('');
  React.useEffect(() => {
    setShowAll(false);
    setSearch('');
  }, [line]);
  if (!line) return null;
  const sameAmount = candidates.filter((c) => signedLedger(c, currency) === line.amount);
  const pool = (showAll || sameAmount.length === 0 ? candidates : sameAmount).filter((c) =>
    search
      ? `${c.journalNumber} ${c.reference ?? ''} ${c.description ?? ''}`
          .toLowerCase()
          .includes(search.toLowerCase())
      : true,
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Match line {line.lineNumber}: {line.description}
          </DialogTitle>
          <DialogDescription>
            {line.lineDate} · {line.amount}. Pick the posted ledger line this statement line
            represents; the amount must agree exactly.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Journal, reference, description"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72"
          />
          {sameAmount.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Same amount only' : `Show all ${candidates.length}`}
            </Button>
          ) : null}
        </div>
        <Card>
          <CardContent className="max-h-80 overflow-y-auto p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Date</TableHead>
                  <TableHead>Journal</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pool.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                      No unmatched ledger line fits. Record the item instead.
                    </TableCell>
                  </TableRow>
                ) : (
                  pool.map((c) => (
                    <TableRow key={c.journalLineId} data-testid="match-candidate">
                      <TableCell className="whitespace-nowrap">{c.entryDate}</TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{c.journalNumber}</span>
                        <div className="text-xs text-muted-foreground">
                          {c.reference ? <span className="font-mono">{c.reference} · </span> : null}
                          {c.description}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Amount value={signedLedger(c, currency)} currency={currency} />
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          disabled={act.isPending || signedLedger(c, currency) !== line.amount}
                          onClick={async () => {
                            try {
                              await act.mutateAsync({
                                statementId,
                                action: 'match',
                                lineId: line.id,
                                journalLineId: c.journalLineId,
                              });
                              toast.success('Line matched.');
                              onOpenChange(false);
                            } catch (err) {
                              toast.error(describeError(err));
                            }
                          }}
                        >
                          Match
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </DialogContent>
    </Dialog>
  );
}
