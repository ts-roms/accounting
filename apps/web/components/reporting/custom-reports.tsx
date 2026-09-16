'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Copy, Pencil, Play, Save } from 'lucide-react';
import { toast } from 'sonner';
import { P } from '@accounting/types';
import {
  reportLayoutSchema,
  type ReportLayoutInput,
  type RunReportInput,
} from '@accounting/validation';
import {
  Badge,
  Button,
  Card,
  CardContent,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
} from '@accounting/ui';
import { describeError } from '@/lib/api/client';
import { useBranches } from '@/lib/api/hooks';
import { useBudgets, useDimensions } from '@/lib/api/budgeting-tax-hooks';
import {
  useCopyReportDefinition,
  useReportDefinitions,
  useReportRun,
  useRunAdHocReport,
  useUpdateReportDefinition,
} from '@/lib/api/reporting-engine-hooks';
import type { ReportDefinitionView, ReportLineResult, ReportResult } from '@/lib/api/types';
import { useSession } from '@/lib/auth/session';
import { Can, EmptyState, ErrorState, PageHeader, TableSkeleton } from '@/components/ui-ext/page';
import { Amount, DateRange, endOfMonth, startOfMonth } from '@/components/accounting/primitives';

const ALL = '__all__';

/**
 * Configurable reports: run system / custom definitions for a period with
 * optional branch, dimension and budget filters; copy a definition and edit
 * the copy's layout (JSON) with a live preview. Every figure comes from the
 * API's reporting engine - the page holds no arithmetic.
 */
export function CustomReportsPage() {
  const { activeCompany } = useSession();
  const search = useSearchParams();
  const defs = useReportDefinitions({ status: 'ACTIVE' });
  const [selectedId, setSelectedId] = React.useState<string | null>(search.get('id'));
  const [range, setRange] = React.useState({ from: startOfMonth(), to: endOfMonth() });
  const [branchId, setBranchId] = React.useState(ALL);
  const [departmentId, setDepartmentId] = React.useState(ALL);
  const [budgetId, setBudgetId] = React.useState(ALL);
  const [includeZero, setIncludeZero] = React.useState(false);
  const [copying, setCopying] = React.useState<ReportDefinitionView | null>(null);
  const [editing, setEditing] = React.useState<ReportDefinitionView | null>(null);

  const items = React.useMemo(() => defs.data?.items ?? [], [defs.data]);
  const definition = items.find((d) => d.id === selectedId) ?? items[0] ?? null;
  React.useEffect(() => {
    if (!selectedId && items[0]) setSelectedId(items[0].id);
  }, [items, selectedId]);

  const params = React.useMemo<RunReportInput | null>(
    () =>
      range.from && range.to
        ? {
            from: range.from,
            to: range.to,
            includeZero,
            ...(branchId !== ALL ? { branchId } : {}),
            ...(departmentId !== ALL ? { departmentId } : {}),
            ...(budgetId !== ALL ? { budgetId } : {}),
          }
        : null,
    [range, includeZero, branchId, departmentId, budgetId],
  );
  const run = useReportRun(definition?.id ?? null, params);
  const branches = useBranches(activeCompany?.id);
  const departments = useDimensions('DEPARTMENT', 'ACTIVE');
  const budgets = useBudgets({ pageSize: 50 });
  const hasBudget = definition?.layout.columns.some((c) => c.kind === 'BUDGET') ?? false;

  return (
    <>
      <PageHeader
        title="Custom Reports"
        description="Configurable financial and management reports: comparative periods, year to date, budget variances, formulas and dimension groups - every figure read from posted journals and approved budgets."
        actions={
          definition ? (
            <div className="flex gap-2">
              <Can permissions={[P['report-definition.manage']]}>
                <Button
                  variant="outline"
                  onClick={() => setCopying(definition)}
                  data-testid="report-copy"
                >
                  <Copy /> Copy
                </Button>
                {!definition.isSystem ? (
                  <Button
                    variant="outline"
                    onClick={() => setEditing(definition)}
                    data-testid="report-edit"
                  >
                    <Pencil /> Edit layout
                  </Button>
                ) : null}
              </Can>
            </div>
          ) : null
        }
      />
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="space-y-1">
            <Label htmlFor="report-definition">Report</Label>
            <Select value={definition?.id ?? ''} onValueChange={setSelectedId}>
              <SelectTrigger
                id="report-definition"
                className="w-72"
                data-testid="report-definition"
              >
                <SelectValue placeholder="Choose a report" />
              </SelectTrigger>
              <SelectContent>
                {items.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                    {d.isSystem ? '' : ' (custom)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DateRange
            from={range.from}
            to={range.to}
            onChange={setRange}
            labels={definition?.basis === 'AS_OF' ? ['Period start', 'As of'] : ['From', 'To']}
          />
          <div className="space-y-1">
            <Label htmlFor="report-branch">Branch</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger id="report-branch" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All branches</SelectItem>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.code} {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="report-department">Department</Label>
            <Select value={departmentId} onValueChange={setDepartmentId}>
              <SelectTrigger
                id="report-department"
                className="w-44"
                data-testid="report-department"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All departments</SelectItem>
                {(departments.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasBudget ? (
            <div className="space-y-1">
              <Label htmlFor="report-budget">Budget</Label>
              <Select value={budgetId} onValueChange={setBudgetId}>
                <SelectTrigger id="report-budget" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Approved budget of the year</SelectItem>
                  {(budgets.data?.items ?? []).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.code} {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeZero}
              onChange={(e) => setIncludeZero(e.target.checked)}
              data-testid="report-include-zero"
            />
            Show zero lines
          </label>
        </CardContent>
      </Card>
      {definition?.description ? (
        <p className="text-sm text-muted-foreground">
          {definition.description}{' '}
          <Badge variant="outline" className="ml-1">
            {definition.basis === 'AS_OF' ? 'As of' : 'Period'}
          </Badge>
          <Badge variant="secondary" className="ml-1">
            {definition.category}
          </Badge>
        </p>
      ) : null}
      <Card>
        <CardContent className="p-0">
          {defs.isError ? (
            <ErrorState description={describeError(defs.error)} />
          ) : run.isError ? (
            <ErrorState description={describeError(run.error)} />
          ) : !definition || run.isLoading || !run.data ? (
            <TableSkeleton columns={4} rows={12} />
          ) : (
            <ReportGrid result={run.data} />
          )}
        </CardContent>
      </Card>
      {copying ? (
        <CopyDialog
          source={copying}
          onClose={() => setCopying(null)}
          onCopied={(d) => setSelectedId(d.id)}
        />
      ) : null}
      {editing && params ? (
        <LayoutEditor definition={editing} params={params} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}

/** Renders a report result: one column per definition column, rows in layout order with drill-down links. */
export function ReportGrid({ result }: { result: ReportResult }) {
  if (result.rows.length === 0)
    return <EmptyState title="Nothing to report" description="No rows for these parameters." />;
  const ledgerHref = (line: ReportLineResult, columnKey: string) => {
    const col = result.columns.find((c) => c.key === columnKey);
    if (!line.accountId || !col || !col.to) return null;
    const from = col.from ?? '2000-01-01';
    return `/accounting/general-ledger?accountId=${line.accountId}&from=${from}&to=${col.to}`;
  };
  return (
    <div className="overflow-x-auto">
      <Table data-testid="report-grid">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-64">
              {result.definition.name}{' '}
              <span className="text-muted-foreground">({result.currency})</span>
            </TableHead>
            {result.columns.map((c) => (
              <TableHead
                key={c.key}
                className="w-40 text-right"
                title={c.from ? `${c.from} to ${c.to}` : (c.to ?? '')}
              >
                <div>{c.label}</div>
                {c.to ? (
                  <div className="type-label font-normal text-muted-foreground">
                    {c.from ? `${c.from} - ${c.to}` : `as of ${c.to}`}
                  </div>
                ) : null}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((line, i) => (
            <TableRow
              key={`${line.key}-${line.accountId ?? line.dimensionId ?? i}`}
              data-testid="report-row"
              data-key={line.key}
              data-kind={line.kind}
              className={cn(line.kind === 'HEADER' && 'bg-muted/40', line.bold && 'font-semibold')}
            >
              <TableCell
                className={cn(
                  line.level > 0 && 'pl-8 text-muted-foreground',
                  line.kind === 'FORMULA' && 'border-t',
                )}
              >
                {line.label}
              </TableCell>
              {result.columns.map((c) => {
                const value = line.values[c.key];
                const href = ledgerHref(line, c.key);
                const cell =
                  c.kind === 'VARIANCE_PCT' ? (
                    <span className="tabular block text-right">
                      {value === null || value === undefined ? '-' : `${value}%`}
                    </span>
                  ) : (
                    <Amount value={value} currency={result.currency} zeroAsDash />
                  );
                return (
                  <TableCell key={c.key} className={cn(line.kind === 'FORMULA' && 'border-t')}>
                    {href ? (
                      <Link
                        href={href}
                        className="block hover:underline"
                        title="Open the ledger for this account and window"
                      >
                        {cell}
                      </Link>
                    ) : (
                      cell
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="type-label p-3 text-muted-foreground">
        Generated {new Date(result.generatedAt).toLocaleString()}.
      </p>
    </div>
  );
}

function CopyDialog({
  source,
  onClose,
  onCopied,
}: {
  source: ReportDefinitionView;
  onClose: () => void;
  onCopied: (d: ReportDefinitionView) => void;
}) {
  const copy = useCopyReportDefinition();
  const [code, setCode] = React.useState(`${source.code}_COPY`);
  const [name, setName] = React.useState(`${source.name} (copy)`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy report</DialogTitle>
          <DialogDescription>
            Copies rows, columns and filters of {source.name} into a custom report you can edit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label htmlFor="copy-code">Code</Label>
            <Input
              id="copy-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              data-testid="report-copy-code"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="copy-name">Name</Label>
            <Input
              id="copy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="report-copy-name"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={copy.isPending || !code || !name}
            onClick={() =>
              copy.mutate(
                { id: source.id, code, name },
                {
                  onSuccess: (d) => {
                    toast.success(`Created ${d.name}`);
                    onCopied(d);
                    onClose();
                  },
                  onError: (e) => toast.error(describeError(e)),
                },
              )
            }
            data-testid="report-copy-submit"
          >
            <Copy /> Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Edits a custom definition's layout as JSON with a server-side preview (ad hoc run) before saving. */
function LayoutEditor({
  definition,
  params,
  onClose,
}: {
  definition: ReportDefinitionView;
  params: RunReportInput;
  onClose: () => void;
}) {
  const update = useUpdateReportDefinition();
  const preview = useRunAdHocReport();
  const [name, setName] = React.useState(definition.name);
  const [text, setText] = React.useState(JSON.stringify(definition.layout, null, 2));
  const [error, setError] = React.useState<string | null>(null);
  const parse = (): ReportLayoutInput | null => {
    try {
      const parsed = reportLayoutSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        setError(
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'layout'}: ${i.message}`)
            .join('\n'),
        );
        return null;
      }
      setError(null);
      return parsed.data;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
      return null;
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Edit layout - {definition.code}</DialogTitle>
          <DialogDescription>
            Rows: HEADER, ACCOUNTS (selector by codes / types / mapping keys), FORMULA (KEY + KEY -
            KEY) or DIMENSION_GROUP. Columns: CURRENT, PRIOR_PERIOD, YEAR_TO_DATE, PRIOR_YEAR,
            BUDGET, CUSTOM_RANGE, VARIANCE, VARIANCE_PCT. Preview runs the layout without saving.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <div className="space-y-1">
              <Label htmlFor="layout-name">Name</Label>
              <Input id="layout-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={22}
              className="font-mono text-xs"
              data-testid="report-layout-json"
            />
            {error ? (
              <pre
                className="type-label whitespace-pre-wrap text-negative"
                data-testid="report-layout-error"
              >
                {error}
              </pre>
            ) : null}
          </div>
          <div className="max-h-[32rem] overflow-auto rounded-md border">
            {preview.isPending ? (
              <TableSkeleton columns={3} rows={8} />
            ) : preview.data ? (
              <ReportGrid result={preview.data} />
            ) : (
              <EmptyState
                title="No preview yet"
                description="Run a preview to see the figures for the current parameters."
              />
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={preview.isPending}
            onClick={() => {
              const layout = parse();
              if (layout)
                preview.mutate(
                  { basis: definition.basis, layout, params },
                  { onError: (e) => setError(describeError(e)) },
                );
            }}
            data-testid="report-layout-preview"
          >
            <Play /> Preview
          </Button>
          <Button
            disabled={update.isPending}
            onClick={() => {
              const layout = parse();
              if (!layout) return;
              update.mutate(
                { id: definition.id, name, layout },
                {
                  onSuccess: () => {
                    toast.success('Report saved');
                    onClose();
                  },
                  onError: (e) => setError(describeError(e)),
                },
              );
            }}
            data-testid="report-layout-save"
          >
            <Save /> Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
