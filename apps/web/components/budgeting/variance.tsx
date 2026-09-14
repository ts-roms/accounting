'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Money } from '@accounting/money';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@accounting/ui';
import { useBudget, useBudgets, useVariance } from '@/lib/api/budgeting-tax-hooks';
import type { VarianceRow, VarianceTotals } from '@/lib/api/types';
import { EmptyState, PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { DimensionSelect } from '@/components/dimensions/pickers';
import { Stat } from '@/components/fixed-assets/shared';
import { BUDGETS_PATH } from './budgets';

const NONE = '__none__';

export function VariancePage() {
  const params = useSearchParams();
  const budgets = useBudgets({ pageSize: 100, status: 'ACTIVE' });
  const [budgetId, setBudgetId] = React.useState<string | null>(params.get('budgetId'));
  const [versionId, setVersionId] = React.useState<string>(NONE);
  const [toPeriodId, setToPeriodId] = React.useState<string>(NONE);
  const [departmentId, setDepartmentId] = React.useState<string | null>(null);
  const [costCenterId, setCostCenterId] = React.useState<string | null>(null);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!budgetId && budgets.data?.items[0]) setBudgetId(budgets.data.items[0].id);
  }, [budgetId, budgets.data]);
  const budget = useBudget(budgetId);
  const report = useVariance(budgetId, {
    versionId: versionId === NONE ? undefined : versionId,
    toPeriodId: toPeriodId === NONE ? undefined : toPeriodId,
    departmentId,
    costCenterId,
    projectId,
  });
  const r = report.data;
  const currency = r?.currency ?? 'PHP';
  const fmtPct = (v: string | null) => (v === null ? '-' : `${Number(v).toFixed(1)}%`);
  const rowsOf = (type: string) => (r?.rows ?? []).filter((x) => x.type === type);

  return (
    <>
      <PageHeader
        title="Variance analysis"
        description="Budget versus actual per account and period. Actuals are posted journal lines in the fiscal year's periods; filter by dimension to compare a department, cost center or project."
      />
      <Card>
        <CardContent className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-6">
          <div className="space-y-1">
            <Label>Budget</Label>
            <Select
              value={budgetId ?? ''}
              onValueChange={(v) => {
                setBudgetId(v);
                setVersionId(NONE);
              }}
            >
              <SelectTrigger data-testid="variance-budget">
                <SelectValue placeholder="Select budget" />
              </SelectTrigger>
              <SelectContent>
                {budgets.data?.items.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.code} · {b.fiscalYearName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Version</Label>
            <Select value={versionId} onValueChange={setVersionId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Approved version</SelectItem>
                {budget.data?.versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    v{v.versionNumber} {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Through period</Label>
            <Select value={toPeriodId} onValueChange={setToPeriodId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Whole year</SelectItem>
                {budget.data?.periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Department</Label>
            <DimensionSelect
              type="DEPARTMENT"
              value={departmentId}
              onChange={setDepartmentId}
              placeholder="All departments"
            />
          </div>
          <div className="space-y-1">
            <Label>Cost center</Label>
            <DimensionSelect
              type="COST_CENTER"
              value={costCenterId}
              onChange={setCostCenterId}
              placeholder="All cost centers"
            />
          </div>
          <div className="space-y-1">
            <Label>Project</Label>
            <DimensionSelect
              type="PROJECT"
              value={projectId}
              onChange={setProjectId}
              placeholder="All projects"
            />
          </div>
        </CardContent>
      </Card>
      {!budgetId ? (
        <EmptyState
          title="No active budget"
          description="Create and approve a budget to compare it with actuals."
        />
      ) : report.isLoading || !r ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <TotalsStat
              label="Revenue"
              t={r.totals.revenue}
              currency={currency}
              favourableWhenPositive
            />
            <TotalsStat
              label="Expenses"
              t={r.totals.expense}
              currency={currency}
              favourableWhenPositive={false}
            />
            <TotalsStat label="Net" t={r.totals.net} currency={currency} favourableWhenPositive />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{r.versionName}</CardTitle>
              <CardDescription>
                <Link href={`${BUDGETS_PATH}/${r.budgetId}`} className="hover:underline">
                  Open budget
                </Link>{' '}
                · {r.periods.length} period(s) · variance = actual − budget; for expenses a positive
                variance means over budget.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-[240px]">Account</TableHead>
                    {r.periods.map((p) => (
                      <TableHead key={p.id} className="min-w-[120px] text-right text-xs">
                        {p.name.replace(/ \d{4}$/, '').slice(0, 3)}
                        <div className="font-normal text-muted-foreground">act / bud</div>
                      </TableHead>
                    ))}
                    <TableHead className="min-w-[120px] text-right">Budget</TableHead>
                    <TableHead className="min-w-[120px] text-right">Actual</TableHead>
                    <TableHead className="min-w-[120px] text-right">Variance</TableHead>
                    <TableHead className="w-20 text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={r.periods.length + 5}
                        className="py-8 text-center text-muted-foreground"
                      >
                        Nothing budgeted or posted for this selection.
                      </TableCell>
                    </TableRow>
                  ) : (
                    (['REVENUE', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY'] as const).flatMap(
                      (type) => {
                        const rows = rowsOf(type);
                        if (rows.length === 0) return [];
                        return [
                          <TableRow key={`${type}-h`} className="bg-muted/40 hover:bg-muted/40">
                            <TableCell
                              colSpan={r.periods.length + 5}
                              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                            >
                              {type}
                            </TableCell>
                          </TableRow>,
                          ...rows.map((row) => (
                            <VarianceLine
                              key={row.accountId}
                              row={row}
                              currency={currency}
                              expense={type === 'EXPENSE' || type === 'ASSET'}
                            />
                          )),
                        ];
                      },
                    )
                  )}
                </TableBody>
                {r.rows.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell colSpan={r.periods.length + 1}>Net (revenue − expenses)</TableCell>
                      <TableCell>
                        <Amount
                          value={r.totals.net.budget}
                          currency={currency}
                          className="font-semibold"
                        />
                      </TableCell>
                      <TableCell>
                        <Amount
                          value={r.totals.net.actual}
                          currency={currency}
                          className="font-semibold"
                        />
                      </TableCell>
                      <TableCell>
                        <Amount
                          value={r.totals.net.variance}
                          currency={currency}
                          className={cn(
                            'font-semibold',
                            Number(r.totals.net.variance) < 0 && 'text-destructive',
                          )}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular text-xs">
                        {fmtPct(
                          Money.of(r.totals.net.budget, currency).isZero()
                            ? null
                            : Money.of(r.totals.net.variance, currency)
                                .divide(Money.of(r.totals.net.budget, currency).abs().toString())
                                .multiply('100')
                                .toString(),
                        )}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                ) : null}
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

function TotalsStat({
  label,
  t,
  currency,
  favourableWhenPositive,
}: {
  label: string;
  t: VarianceTotals;
  currency: string;
  favourableWhenPositive: boolean;
}) {
  const v = Number(t.variance);
  const bad = favourableWhenPositive ? v < 0 : v > 0;
  return (
    <Stat
      label={label}
      value={<Amount value={t.actual} currency={currency} className="text-left" />}
      hint={
        <span>
          budget {t.budget} · variance{' '}
          <span className={bad ? 'text-destructive' : 'text-emerald-600'}>{t.variance}</span>
        </span>
      }
    />
  );
}

function VarianceLine({
  row,
  currency,
  expense,
}: {
  row: VarianceRow;
  currency: string;
  expense: boolean;
}) {
  const v = Number(row.variance);
  const bad = expense ? v > 0 : v < 0;
  return (
    <TableRow className="hover:bg-transparent" data-testid="variance-row">
      <TableCell>
        <span className="mr-2 font-mono text-xs text-muted-foreground">{row.code}</span>
        {row.name}
      </TableCell>
      {row.cells.map((c) => (
        <TableCell key={c.periodId} className="text-right text-xs tabular">
          <Amount value={c.actual} className="text-xs" zeroAsDash />
          <Amount value={c.budget} className="text-xs text-muted-foreground" zeroAsDash />
        </TableCell>
      ))}
      <TableCell>
        <Amount value={row.budget} currency={currency} zeroAsDash />
      </TableCell>
      <TableCell>
        <Amount value={row.actual} currency={currency} zeroAsDash />
      </TableCell>
      <TableCell>
        <Amount
          value={row.variance}
          currency={currency}
          className={bad ? 'text-destructive' : undefined}
          zeroAsDash
        />
      </TableCell>
      <TableCell className="text-right tabular text-xs">
        {row.variancePercent === null ? '-' : `${Number(row.variancePercent).toFixed(1)}%`}
      </TableCell>
    </TableRow>
  );
}
