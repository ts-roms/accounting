'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useAppRouter } from '@/lib/navigation/progress';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Money } from '@accounting/money';
import { P } from '@accounting/types';
import type { StatementLineInput } from '@accounting/validation';
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
  Input,
  Label,
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
  useBankAccounts,
  useBankStatements,
  useImportStatement,
  useParseStatementFile,
} from '@/lib/api/assets-banking-hooks';
import type { BankStatement } from '@/lib/api/types';
import { DataTable, useTableState } from '@/components/ui-ext/data-table';
import { Can, PageHeader } from '@/components/ui-ext/page';
import { Amount, today } from '@/components/accounting/primitives';
import { BankAccountSelect, RECONCILIATION_PATH, StatementStatusBadge } from './shared';

export function BankStatementsPage() {
  const router = useAppRouter();
  const params = useSearchParams();
  const table = useTableState({ sortBy: 'statementDate', sortDir: 'desc' });
  const [bankAccountId, setBankAccountId] = React.useState<string | null>(
    params.get('bankAccountId'),
  );
  const statements = useBankStatements({
    ...table.query,
    bankAccountId: bankAccountId ?? undefined,
  });
  const columns = React.useMemo<ColumnDef<BankStatement>[]>(
    () => [
      {
        accessorKey: 'statementDate',
        header: 'Statement date',
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.statementDate}</span>,
      },
      {
        accessorKey: 'statementNumber',
        header: 'Number',
        cell: ({ row }) => (
          <Link
            href={`${RECONCILIATION_PATH}/${row.original.id}`}
            className="font-mono text-xs font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.statementNumber}
          </Link>
        ),
      },
      {
        id: 'account',
        header: 'Bank account',
        enableSorting: false,
        cell: ({ row }) => `${row.original.bankAccountCode} · ${row.original.bankAccountName}`,
      },
      {
        id: 'closing',
        header: () => <div className="text-right">Closing balance</div>,
        enableSorting: false,
        cell: ({ row }) => <Amount value={row.original.closingBalance} />,
      },
      {
        id: 'progress',
        header: 'Lines',
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          return (
            <span className="text-xs">
              {s.matchedCount}/{s.lineCount} matched
              {s.exceptionCount > 0 ? (
                <span className="ml-1 text-critical">· {s.exceptionCount} exceptions</span>
              ) : null}
              {s.unmatchedCount > 0 ? (
                <span className="ml-1 text-muted-foreground">· {s.unmatchedCount} unmatched</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        enableSorting: false,
        cell: ({ row }) => <StatementStatusBadge status={row.original.status} />,
      },
    ],
    [],
  );
  return (
    <>
      <PageHeader
        title="Bank reconciliation"
        description="Import a statement, let the matcher pair lines with posted ledger lines, review exceptions, record what the bank charged, and complete when the difference is zero."
        actions={
          <Can permissions={[P['bank-statement.import']]}>
            <Button asChild data-testid="import-statement">
              <Link href={`${RECONCILIATION_PATH}/import`}>
                <Upload /> Import statement
              </Link>
            </Button>
          </Can>
        }
      />
      <DataTable
        columns={columns}
        data={statements.data}
        isLoading={statements.isLoading}
        isFetching={statements.isFetching}
        pagination={table.pagination}
        sorting={table.sorting}
        getRowId={(s) => s.id}
        onRowClick={(s) => router.push(`${RECONCILIATION_PATH}/${s.id}`)}
        toolbar={
          <BankAccountSelect
            value={bankAccountId}
            onChange={(id) => {
              setBankAccountId(id);
              table.resetPage();
            }}
            allowAll="All bank accounts"
            className="w-56"
          />
        }
      />
    </>
  );
}

/**
 * Parses pasted / uploaded statement text. Accepts CSV with a header row
 * (date, description, reference?, amount | debit + credit, balance?) or
 * tab-separated rows in the same column order.
 */
export function parseStatementText(text: string): {
  lines: StatementLineInput[];
  errors: string[];
} {
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);
  const errors: string[] = [];
  if (rows.length === 0) return { lines: [], errors: ['Nothing to import.'] };
  const split = (row: string) => {
    const delimiter = row.includes('\t')
      ? '\t'
      : row.includes(';') && !row.includes(',')
        ? ';'
        : ',';
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (const ch of row) {
      if (ch === '"') quoted = !quoted;
      else if (ch === delimiter && !quoted) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const first = split(rows[0]!).map((h) => h.toLowerCase());
  const hasHeader = first.some((h) => /date|desc|amount|debit|credit|ref/.test(h));
  const idx = (names: string[], fallback: number) => {
    const i = first.findIndex((h) => names.some((n) => h.includes(n)));
    return hasHeader ? i : fallback;
  };
  const cDate = idx(['date'], 0);
  const cDesc = idx(['desc', 'particular', 'narrat', 'detail'], 1);
  const cRef = idx(['ref', 'cheque', 'check'], 2);
  const cAmount = idx(['amount'], 3);
  const cDebit = idx(['debit', 'withdraw', 'out'], -1);
  const cCredit = idx(['credit', 'deposit', 'in'], -1);
  const cBalance = idx(['balance'], 4);
  const toIso = (raw: string): string | null => {
    const s = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) {
      // Assume day-first only when the first field cannot be a month.
      const a = Number(m[1]);
      const b = Number(m[2]);
      const [month, day] = a > 12 ? [b, a] : [a, b];
      return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const num = (raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    let s = raw.replace(/[",\s]/g, '').replace(/^\((.*)\)$/, '-$1');
    if (s === '' || s === '-') return null;
    if (/^[A-Z]{3}/.test(s)) s = s.slice(3);
    return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
  };
  const lines: StatementLineInput[] = [];
  rows.slice(hasHeader ? 1 : 0).forEach((row, i) => {
    const cols = split(row);
    const lineNo = i + 1 + (hasHeader ? 1 : 0);
    const date = toIso(cols[cDate] ?? '');
    if (!date) return errors.push(`Line ${lineNo}: unreadable date "${cols[cDate] ?? ''}".`);
    let amount: string | null = null;
    if (cDebit >= 0 || cCredit >= 0) {
      const debit = num(cols[cDebit]);
      const credit = num(cols[cCredit]);
      if (debit && Number(debit) !== 0) amount = `-${debit.replace('-', '')}`;
      else if (credit && Number(credit) !== 0) amount = credit.replace('-', '');
    } else amount = num(cols[cAmount]);
    if (!amount || Number(amount) === 0) return errors.push(`Line ${lineNo}: no amount.`);
    const balance = cBalance >= 0 ? num(cols[cBalance]) : null;
    lines.push({
      lineDate: date,
      description: cols[cDesc] || 'Statement line',
      reference: cRef >= 0 && cols[cRef] ? cols[cRef] : undefined,
      amount,
      balance: balance ?? undefined,
    });
  });
  return { lines, errors };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function ImportStatementPage() {
  const router = useAppRouter();
  const params = useSearchParams();
  const accounts = useBankAccounts();
  const importStatement = useImportStatement();
  const [bankAccountId, setBankAccountId] = React.useState<string | null>(
    params.get('bankAccountId'),
  );
  const [statementDate, setStatementDate] = React.useState(today());
  const [openingBalance, setOpeningBalance] = React.useState('');
  const [closingBalance, setClosingBalance] = React.useState('');
  const [fileName, setFileName] = React.useState<string | undefined>();
  const [text, setText] = React.useState('');
  const parsed = React.useMemo(() => (text.trim() ? parseStatementText(text) : null), [text]);
  const account = accounts.data?.find((a) => a.id === bankAccountId);
  const currency = account?.currency ?? 'PHP';
  const movement = parsed
    ? Money.sum(
        parsed.lines.map((l) => Money.parse(l.amount, currency)),
        currency,
      )
    : Money.zero(currency);
  const expectedClosing =
    openingBalance.trim() !== '' && /^-?\d+(\.\d+)?$/.test(openingBalance.trim())
      ? Money.parse(openingBalance.trim(), currency).add(movement)
      : null;
  const closingOk =
    expectedClosing && /^-?\d+(\.\d+)?$/.test(closingBalance.trim())
      ? expectedClosing.equals(Money.parse(closingBalance.trim(), currency))
      : null;

  const parseFile = useParseStatementFile();
  const [fileInfo, setFileInfo] = React.useState<string | null>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setFileInfo(null);
    const content = await file.text();
    // Bank exports (MT940, camt.053, OFX / QFX) are parsed by the API into the
    // same lines a CSV gives, plus the balances and date the file carries.
    if (
      /^:20:|:60F:|<Document|<BkToCstmrStmt|<OFX>|OFXHEADER|<STMTTRN>/m.test(content.slice(0, 4000))
    ) {
      try {
        const parsed = await parseFile.mutateAsync(file);
        setStatementDate(parsed.statementDate);
        setOpeningBalance(parsed.openingBalance);
        setClosingBalance(parsed.closingBalance);
        setText(
          [
            'date,description,reference,amount',
            ...parsed.lines.map((l) =>
              [l.lineDate, csvCell(l.description), csvCell(l.reference ?? ''), l.amount].join(','),
            ),
          ].join('\n'),
        );
        setFileInfo(
          `${parsed.format}${parsed.accountRef ? ` · account ${parsed.accountRef}` : ''}${parsed.currency ? ` · ${parsed.currency}` : ''}${parsed.warnings.length ? ` · ${parsed.warnings.join(' ')}` : ''}`,
        );
        return;
      } catch (err) {
        toast.error(describeError(err));
        return;
      }
    }
    setText(content);
  };

  const submit = async () => {
    if (!bankAccountId || !parsed) return;
    try {
      const created = await importStatement.mutateAsync({
        bankAccountId,
        statementDate,
        openingBalance: openingBalance.trim(),
        closingBalance: closingBalance.trim(),
        fileName,
        lines: parsed.lines,
      });
      toast.success(
        `${created.statementNumber} imported: ${created.matchedCount}/${created.lineCount} lines matched.`,
      );
      router.push(`${RECONCILIATION_PATH}/${created.id}`);
    } catch (err) {
      toast.error(describeError(err));
    }
  };

  return (
    <>
      <PageHeader
        title="Import bank statement"
        description="Paste or upload the statement lines. Money in is positive, money out negative; opening + lines must equal the closing balance."
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href={RECONCILIATION_PATH}>
              <ArrowLeft /> Statements
            </Link>
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Statement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Bank account</Label>
              <BankAccountSelect
                value={bankAccountId}
                onChange={setBankAccountId}
                testId="stm-bank-account"
              />
              {account ? (
                <p className="text-xs text-muted-foreground">
                  Ledger balance {account.ledgerBalance} · last statement{' '}
                  {account.lastStatementDate ?? '-'}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor="stm-date">Statement date</Label>
              <Input
                id="stm-date"
                type="date"
                value={statementDate}
                onChange={(e) => setStatementDate(e.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Opening balance</Label>
                <Input
                  inputMode="decimal"
                  className="text-right tabular"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                  data-testid="stm-opening"
                />
              </div>
              <div className="space-y-1">
                <Label>Closing balance</Label>
                <Input
                  inputMode="decimal"
                  className="text-right tabular"
                  value={closingBalance}
                  onChange={(e) => setClosingBalance(e.target.value)}
                  data-testid="stm-closing"
                />
              </div>
            </div>
            {expectedClosing ? (
              <p
                className={`text-xs ${closingOk === false ? 'text-critical' : 'text-muted-foreground'}`}
              >
                Opening + {parsed?.lines.length ?? 0} lines = {expectedClosing.toString()}
                {closingOk === false ? ' — does not equal the closing balance.' : ''}
              </p>
            ) : null}
            <div className="space-y-1">
              <Label>File (CSV / TSV, MT940, camt.053, OFX / QFX)</Label>
              <Input
                type="file"
                accept=".csv,.txt,.tsv,.mt940,.sta,.940,.xml,.ofx,.qfx"
                onChange={(e) => void onFile(e.target.files?.[0])}
                data-testid="stm-file"
              />
              {fileInfo ? (
                <p className="text-xs text-muted-foreground" data-testid="stm-file-info">
                  {fileInfo}
                </p>
              ) : null}
            </div>
            <Button
              className="w-full"
              disabled={
                !bankAccountId ||
                !parsed ||
                parsed.lines.length === 0 ||
                parsed.errors.length > 0 ||
                closingOk !== true ||
                importStatement.isPending
              }
              onClick={submit}
              data-testid="stm-import"
            >
              <Upload /> Import {parsed?.lines.length ?? 0} lines
            </Button>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
              <CardDescription>
                Columns: date, description, reference, amount (or debit / credit), balance. A header
                row is optional.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                rows={8}
                className="font-mono text-xs"
                placeholder={
                  'date,description,reference,amount\n2026-09-02,Deposit,DEP-1,5000\n2026-09-07,Service fee,FEE,-350'
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                data-testid="stm-text"
              />
            </CardContent>
          </Card>
          {parsed?.errors.length ? (
            <Alert variant="destructive">
              <AlertTitle>{parsed.errors.length} line(s) could not be read</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {parsed.errors.slice(0, 8).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {parsed && parsed.lines.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Preview</CardTitle>
                <CardDescription>
                  {parsed.lines.length} lines · net movement {movement.toString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Date</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsed.lines.slice(0, 50).map((l, i) => (
                      <TableRow key={i}>
                        <TableCell className="whitespace-nowrap">{l.lineDate}</TableCell>
                        <TableCell>{l.description}</TableCell>
                        <TableCell className="font-mono text-xs">{l.reference ?? '-'}</TableCell>
                        <TableCell>
                          <Amount value={l.amount} currency={currency} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
