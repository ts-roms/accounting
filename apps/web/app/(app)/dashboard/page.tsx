'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Building2,
  ClipboardList,
  Inbox,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import { Money } from '@accounting/money';
import { AGING_BUCKETS, P } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  StatusBadge,
} from '@accounting/ui';
import { useSession } from '@/lib/auth/session';
import { PendingApprovalsCard } from '@/components/enterprise/pending-approvals-card';
import { useAuditLogs, useCompanies, useRoles, useUsers } from '@/lib/api/hooks';
import {
  useBalanceSheet,
  useIncomeStatementTrend,
  useJournalEntries,
} from '@/lib/api/accounting-hooks';
import type { IncomeStatementTrendPoint } from '@/lib/api/types';
import { useAging } from '@/lib/api/subledger-hooks';
import { AP_CONFIG, AR_CONFIG } from '@/lib/subledger/config';
import { endOfMonth, startOfMonth, today } from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { formatDate, formatDateTime } from '@/lib/format';
import { FinancialMetricCard } from '@/components/financial/metric-card';
import { FinancialHealth } from '@/components/financial/financial-health';
import { CurrencyDisplay } from '@/components/financial/display';
import { BarChart, DonutChart, chartColor } from '@/components/charts/charts';

const MONTHS = 6;

function monthRange(offset: number): { from: string; to: string; label: string } {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const iso = d.toISOString().slice(0, 10);
  return {
    from: startOfMonth(iso),
    to: endOfMonth(iso),
    label: d.toLocaleString('en-PH', { month: 'short', timeZone: 'UTC' }),
  };
}

/** Percentage change between two decimal strings (null when the base is zero). */
function pctChange(current: string | undefined, previous: string | undefined): number | null {
  if (current === undefined || previous === undefined) return null;
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
}

/**
 * Financial overview. Every figure is read from the general ledger and the
 * AR/AP aging reports; nothing is estimated on the client. Trend and aging
 * charts draw once when their data arrives.
 */
export default function DashboardPage() {
  const { me, activeCompany, hasPermission } = useSession();
  const canAdmin = hasPermission(P['user.view']);
  const canReport = hasPermission(P['reports.view']) && Boolean(activeCompany);
  const canJournals = hasPermission(P['journal.view']) && Boolean(activeCompany);
  const currency = activeCompany?.baseCurrency ?? 'PHP';
  const now = today();

  const thisMonth = monthRange(0);
  const lastMonth = monthRange(1);
  // One request covers the trend and the month-to-date tiles (last point = this month to today).
  const trend = useIncomeStatementTrend({ to: now, months: MONTHS }, canReport);
  const mtd = trend.data?.months[MONTHS - 1];
  const prev = trend.data?.months[MONTHS - 2];
  const bs = useBalanceSheet({ asOf: now }, canReport);
  const prevBs = useBalanceSheet({ asOf: lastMonth.to }, canReport);
  // Company-scoped: wait for the active company like the report queries do (avoids a 403 on first load).
  const pending = useJournalEntries({ page: 1, pageSize: 1, status: 'SUBMITTED' }, canJournals);
  const arAging = useAging(AR_CONFIG, { asOf: now }, canReport);
  const apAging = useAging(AP_CONFIG, { asOf: now }, canReport);

  const months = React.useMemo(
    () => Array.from({ length: MONTHS }, (_, i) => monthRange(MONTHS - 1 - i)),
    [],
  );
  const trendLoading = canReport && trend.isLoading;
  const trendReady = canReport && Boolean(trend.data);

  const cashOf = (report: typeof bs.data) =>
    report
      ? report.assets.rows
          .filter((r) => !r.isHeader && /cash|bank/i.test(r.name))
          .reduce((acc, r) => acc.add(Money.of(r.amount, currency)), Money.zero(currency))
          .toString()
      : undefined;
  const cash = cashOf(bs.data);
  const prevCash = cashOf(prevBs.data);
  const expensesOf = (r: IncomeStatementTrendPoint | undefined) =>
    r
      ? Money.of(r.costOfSales, currency).add(Money.of(r.expenses, currency)).toString()
      : undefined;
  const overdue = (report: typeof arAging.data) =>
    report
      ? Money.sum(
          // Everything past the first (current) bucket is overdue; buckets are configurable per company.
          report.buckets
            .slice(1)
            .map((b) => Money.of(report.totals[b.key] ?? '0', report.currency)),
          report.currency,
        ).toString()
      : undefined;

  const users = useUsers({ page: 1, pageSize: 1 });
  const roles = useRoles();
  const companies = useCompanies();
  const audit = useAuditLogs({ page: 1, pageSize: 6 });

  return (
    <>
      <PageHeader
        eyebrow="Financial overview"
        title={`Good day, ${me.user.firstName}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{activeCompany ? activeCompany.name : me.organization.name}</span>
            {activeCompany ? (
              <>
                <Sep />
                <span className="font-mono text-xs">{activeCompany.baseCurrency}</span>
                <Sep />
                <span>Period {thisMonth.from.slice(0, 7)}</span>
              </>
            ) : null}
            <Sep />
            <span>{formatDate(now)}</span>
          </span>
        }
      />

      {canReport ? (
        <section aria-label="Key figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <FinancialMetricCard
            label="Revenue (MTD)"
            value={mtd?.revenue}
            currency={currency}
            delta={pctChange(mtd?.revenue, prev?.revenue)}
            deltaLabel="vs last month"
            href="/reports/financial-statements"
            testId="kpi-revenue"
          />
          <FinancialMetricCard
            label="Expenses (MTD)"
            value={expensesOf(mtd)}
            currency={currency}
            delta={pctChange(expensesOf(mtd), expensesOf(prev))}
            deltaLabel="vs last month"
            deltaDirection="down-is-good"
            href="/reports/financial-statements"
            testId="kpi-expenses"
          />
          <FinancialMetricCard
            label="Net income (MTD)"
            value={mtd?.netIncome}
            currency={currency}
            delta={pctChange(mtd?.netIncome, prev?.netIncome)}
            deltaLabel="vs last month"
            href="/reports/financial-statements"
            testId="kpi-net-income"
          />
          <FinancialMetricCard
            label="Cash and bank"
            value={cash}
            currency={currency}
            delta={pctChange(cash, prevCash)}
            deltaLabel="vs month end"
            icon={Wallet}
            href="/reports/financial-statements"
            testId="kpi-cash"
          />
        </section>
      ) : null}

      {canReport ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Revenue and expense trend</CardTitle>
              <CardDescription>
                Monthly totals from the income statement, last {MONTHS} months.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/reports/financial-statements">
                Statements <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {trendLoading || !trendReady ? (
              <BarChart labels={[]} series={[]} loading />
            ) : (
              <BarChart
                labels={months.map((m) => m.label)}
                ariaLabel="Revenue and expenses by month"
                series={[
                  {
                    key: 'revenue',
                    label: 'Revenue',
                    color: chartColor(0),
                    values: trend.data!.months.map((m) => Number(m.revenue)),
                  },
                  {
                    key: 'expenses',
                    label: 'Expenses',
                    color: chartColor(4),
                    values: trend.data!.months.map((m) => Number(expensesOf(m))),
                  },
                ]}
              />
            )}
          </CardContent>
        </Card>
      ) : null}

      {canReport ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <AgingCard
            title="Receivables aging"
            description="Open customer balances by days overdue."
            report={arAging.data}
            loading={arAging.isLoading}
            currency={currency}
            href="/reports/ar-aging"
            overdue={overdue(arAging.data)}
          />
          <AgingCard
            title="Payables aging"
            description="Open vendor balances by days overdue."
            report={apAging.data}
            loading={apAging.isLoading}
            currency={currency}
            href="/reports/ap-aging"
            overdue={overdue(apAging.data)}
          />
        </div>
      ) : null}

      <PendingApprovalsCard />

      <div className="grid gap-4 lg:grid-cols-3">
        <FinancialHealth className="lg:col-span-1" />
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Financial control center</CardTitle>
            <CardDescription>Items that need a decision.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {canJournals ? (
              <ControlRow
                icon={Inbox}
                label="Journals awaiting approval"
                href="/accounting/journal-entries?status=SUBMITTED"
                value={
                  pending.data ? (
                    <StatusBadge tone={pending.data.total > 0 ? 'warning' : 'positive'} size="sm">
                      {pending.data.total}
                    </StatusBadge>
                  ) : (
                    <Skeleton className="h-4 w-8" />
                  )
                }
              />
            ) : null}
            {canReport ? (
              <>
                <ControlRow
                  icon={ClipboardList}
                  label="Overdue receivables"
                  href="/reports/ar-aging"
                  value={
                    overdue(arAging.data) !== undefined ? (
                      <CurrencyDisplay
                        value={overdue(arAging.data)!}
                        currency={currency}
                        className="text-sm font-medium"
                      />
                    ) : (
                      <Skeleton className="h-4 w-20" />
                    )
                  }
                />
                <ControlRow
                  icon={ClipboardList}
                  label="Overdue payables"
                  href="/reports/ap-aging"
                  value={
                    overdue(apAging.data) !== undefined ? (
                      <CurrencyDisplay
                        value={overdue(apAging.data)!}
                        currency={currency}
                        className="text-sm font-medium"
                      />
                    ) : (
                      <Skeleton className="h-4 w-20" />
                    )
                  }
                />
                <ControlRow
                  icon={Building2}
                  label="Total assets"
                  href="/reports/financial-statements"
                  value={
                    bs.data ? (
                      <CurrencyDisplay
                        value={bs.data.totalAssets}
                        currency={currency}
                        className="text-sm font-medium"
                      />
                    ) : (
                      <Skeleton className="h-4 w-20" />
                    )
                  }
                />
              </>
            ) : null}
            {!canReport && !canJournals ? (
              <p className="text-sm text-muted-foreground">
                Financial controls appear here once you are granted reporting access.
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Latest entries in the audit trail.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {!hasPermission(P['audit.view']) ? (
              <p className="text-sm text-muted-foreground">
                You do not have access to the audit trail.
              </p>
            ) : audit.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : audit.data?.items.length ? (
              <>
                <ul className="divide-y">
                  {audit.data.items.map((log) => (
                    <li
                      key={log.id}
                      className="flex items-start justify-between gap-2 py-1.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate">
                          <span className="font-medium">{log.action}</span>{' '}
                          <span className="text-muted-foreground">{log.entityType}</span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {log.userEmail ?? 'system'}
                        </div>
                      </div>
                      <div className="shrink-0 text-xs text-muted-foreground tabular">
                        {formatDateTime(log.occurredAt)}
                      </div>
                    </li>
                  ))}
                </ul>
                <Button variant="link" size="sm" asChild>
                  <Link href="/admin/audit-logs">
                    View audit trail <ArrowRight />
                  </Link>
                </Button>
              </>
            ) : (
              <EmptyState
                compact
                title="No activity yet"
                description="Audit events appear here as work is recorded."
              />
            )}
          </CardContent>
        </Card>
      </div>

      {canAdmin ? (
        <section aria-label="Administration" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FinancialMetricCard
            plain
            label="Companies"
            value={companies.data ? String(companies.data.length) : undefined}
            hint={`${companies.data?.filter((c) => c.status === 'ACTIVE').length ?? 0} active`}
            icon={Building2}
            href="/admin/organization"
            animate={false}
          />
          <FinancialMetricCard
            plain
            label="Users"
            value={users.data ? String(users.data.total) : undefined}
            hint="in this organization"
            icon={Users}
            href="/admin/users"
            animate={false}
          />
          <FinancialMetricCard
            plain
            label="Roles"
            value={roles.data ? String(roles.data.length) : undefined}
            hint={`${roles.data?.filter((r) => !r.isSystem).length ?? 0} custom`}
            icon={ShieldCheck}
            href="/admin/roles"
            animate={false}
          />
          <FinancialMetricCard
            plain
            label="Audit events"
            value={audit.data ? String(audit.data.total) : undefined}
            hint="recorded"
            icon={ClipboardList}
            href="/admin/audit-logs"
            animate={false}
          />
        </section>
      ) : null}
    </>
  );
}

function Sep() {
  return (
    <span className="text-subtle-foreground" aria-hidden>
      ·
    </span>
  );
}

function ControlRow({
  icon: Icon,
  label,
  href,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  href: string;
  value: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-sm transition-colors duration-fast hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4 text-subtle-foreground" />
        {label}
      </span>
      {value}
    </Link>
  );
}

function AgingCard({
  title,
  description,
  report,
  loading,
  currency,
  href,
  overdue,
}: {
  title: string;
  description: string;
  report: ReturnType<typeof useAging>['data'];
  loading: boolean;
  currency: string;
  href: string;
  overdue: string | undefined;
}) {
  // Current is healthy; overdue buckets step from info to warning to critical.
  const tones = [
    'var(--positive)',
    'var(--info)',
    'var(--warning)',
    'var(--warning)',
    'var(--critical)',
  ];
  const total = report ? Number(report.totals.outstanding) : 0;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <Link href={href}>
            Report <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {loading || !report ? (
          <div className="flex items-center gap-4">
            <Skeleton className="size-[140px] rounded-full" />
            <div className="flex-1 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-3" />
              ))}
            </div>
          </div>
        ) : total === 0 ? (
          <EmptyState
            compact
            title="Nothing outstanding"
            description="No open balances on this ledger."
          />
        ) : (
          <DonutChart
            ariaLabel={title}
            segments={AGING_BUCKETS.map((b, i) => ({
              key: b.key,
              label: b.key === 'current' ? 'Current' : `${b.label} days`,
              value: Number(report.totals[b.key]),
              color: tones[i]!,
            }))}
            formatValue={(v) =>
              new Intl.NumberFormat('en-PH', {
                notation: 'compact',
                maximumFractionDigits: 1,
              }).format(v)
            }
            center={
              <div>
                <div className="type-label">Overdue</div>
                <CurrencyDisplay
                  value={overdue ?? '0'}
                  currency={currency}
                  variant="metric"
                  tone={false}
                  fractionDigits={0}
                  className="text-sm font-semibold"
                />
              </div>
            }
          />
        )}
      </CardContent>
    </Card>
  );
}
