'use client';
import Link from 'next/link';
import { ArrowRight, Building2, ClipboardList, ShieldCheck, Users } from 'lucide-react';
import { Money } from '@accounting/money';
import { P } from '@accounting/types';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@accounting/ui';
import { useSession } from '@/lib/auth/session';
import { useAuditLogs, useCompanies, useRoles, useUsers } from '@/lib/api/hooks';
import { useBalanceSheet, useIncomeStatement, useJournalEntries } from '@/lib/api/accounting-hooks';
import { useAging } from '@/lib/api/subledger-hooks';
import { AP_CONFIG, AR_CONFIG } from '@/lib/subledger/config';
import {
  Amount,
  endOfMonth,
  startOfMonth,
  startOfYear,
  today,
} from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { formatDateTime } from '@/lib/format';

/**
 * Cash, net income and pending approvals come straight from the general ledger
 * (Phase 2); receivables and payables from the AR/AP aging reports (Phase 3).
 * KPIs that depend on later phases stay explicit placeholders - never
 * invented numbers.
 */
const PLANNED_KPIS = [
  { label: 'Inventory value', phase: 5 },
  { label: 'Budget variance', phase: 7 },
];

export default function DashboardPage() {
  const { me, activeCompany, hasPermission } = useSession();
  const canAdmin = hasPermission(P['user.view']);
  const users = useUsers({ page: 1, pageSize: 1 });
  const roles = useRoles();
  const companies = useCompanies();
  const audit = useAuditLogs({ page: 1, pageSize: 6 });
  const canReport = hasPermission(P['reports.view']) && Boolean(activeCompany);
  const now = today();
  const mtd = useIncomeStatement({ from: startOfMonth(now), to: endOfMonth(now) }, canReport);
  const ytd = useIncomeStatement({ from: startOfYear(now), to: now }, canReport);
  const bs = useBalanceSheet({ asOf: now }, canReport);
  const pending = useJournalEntries({ page: 1, pageSize: 1, status: 'SUBMITTED' });
  const arAging = useAging(AR_CONFIG, { asOf: now }, canReport);
  const apAging = useAging(AP_CONFIG, { asOf: now }, canReport);
  const overdue = (report: typeof arAging.data) =>
    report
      ? Money.sum(
          (['days1to30', 'days31to60', 'days61to90', 'over90'] as const).map((k) =>
            Money.of(report.totals[k], report.currency),
          ),
          report.currency,
        ).toString()
      : undefined;
  const currency = activeCompany?.baseCurrency ?? 'PHP';
  const cash = bs.data
    ? bs.data.assets.rows
        .filter((r) => !r.isHeader && /cash|bank/i.test(r.name))
        .reduce((acc, r) => acc.add(Money.of(r.amount, currency)), Money.zero(currency))
    : null;

  return (
    <>
      <PageHeader
        title={`Good day, ${me.user.firstName}`}
        description={
          activeCompany
            ? `${activeCompany.name} (${activeCompany.baseCurrency})`
            : me.organization.name
        }
      />

      {canAdmin ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={Building2}
            label="Companies"
            value={companies.data?.length}
            hint={`${companies.data?.filter((c) => c.status === 'ACTIVE').length ?? 0} active`}
            href="/admin/organization"
          />
          <StatCard
            icon={Users}
            label="Users"
            value={users.data?.total}
            hint="in this organization"
            href="/admin/users"
          />
          <StatCard
            icon={ShieldCheck}
            label="Roles"
            value={roles.data?.length}
            hint={`${roles.data?.filter((r) => !r.isSystem).length ?? 0} custom`}
            href="/admin/roles"
          />
          <StatCard
            icon={ClipboardList}
            label="Audit events"
            value={audit.data?.total}
            hint="recorded"
            href="/admin/audit-logs"
          />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Financial overview</CardTitle>
            <CardDescription>
              Figures are derived from the general ledger and become available as each accounting
              phase ships.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {canReport ? (
                <>
                  <LiveKpi
                    label="Cash and bank"
                    value={cash?.toString()}
                    currency={currency}
                    href="/reports/financial-statements"
                  />
                  <LiveKpi
                    label="Net income (MTD)"
                    value={mtd.data?.netIncome}
                    currency={currency}
                    href="/reports/financial-statements"
                  />
                  <LiveKpi
                    label="Net income (YTD)"
                    value={ytd.data?.netIncome}
                    currency={currency}
                    href="/reports/financial-statements"
                  />
                  <LiveKpi
                    label="Revenue (YTD)"
                    value={ytd.data?.revenue.total}
                    currency={currency}
                    href="/reports/financial-statements"
                  />
                  <LiveKpi
                    label="Total assets"
                    value={bs.data?.totalAssets}
                    currency={currency}
                    href="/reports/financial-statements"
                  />
                  <LiveKpi
                    label="Accounts receivable"
                    value={arAging.data?.totals.net}
                    currency={currency}
                    href="/reports/ar-aging"
                  />
                  <LiveKpi
                    label="Overdue receivables"
                    value={overdue(arAging.data)}
                    currency={currency}
                    href="/reports/ar-aging"
                  />
                  <LiveKpi
                    label="Accounts payable"
                    value={apAging.data?.totals.net}
                    currency={currency}
                    href="/reports/ap-aging"
                  />
                  <LiveKpi
                    label="Overdue payables"
                    value={overdue(apAging.data)}
                    currency={currency}
                    href="/reports/ap-aging"
                  />
                  <LiveKpi
                    label="Awaiting approval"
                    value={pending.data ? String(pending.data.total) : undefined}
                    plain
                    href="/accounting/journal-entries?status=SUBMITTED"
                  />
                </>
              ) : null}
              {PLANNED_KPIS.map((kpi) => (
                <div key={kpi.label} className="rounded-md border border-dashed p-3">
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="tabular text-lg font-semibold text-muted-foreground">-</span>
                    <Badge variant="secondary">Phase {kpi.phase}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Latest entries in the audit trail.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {!hasPermission(P['audit.view']) ? (
              <p className="text-sm text-muted-foreground">
                You do not have access to the audit trail.
              </p>
            ) : audit.data?.items.length ? (
              <>
                {audit.data.items.map((log) => (
                  <div key={log.id} className="flex items-start justify-between gap-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate">
                        <span className="font-medium">{log.action}</span>{' '}
                        <span className="text-muted-foreground">{log.entityType}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {log.userEmail ?? 'system'}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground">
                      {formatDateTime(log.occurredAt)}
                    </div>
                  </div>
                ))}
                <Button variant="link" size="sm" className="px-0" asChild>
                  <Link href="/admin/audit-logs">
                    View audit trail <ArrowRight />
                  </Link>
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function LiveKpi({
  label,
  value,
  currency,
  href,
  plain,
}: {
  label: string;
  value: string | undefined;
  currency?: string;
  href: string;
  plain?: boolean;
}) {
  return (
    <Link href={href} className="rounded-md border p-3 transition-colors hover:bg-accent/40">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">
        {value === undefined ? (
          <span className="text-muted-foreground">...</span>
        ) : plain ? (
          <span className="tabular">{value}</span>
        ) : (
          <Amount value={value} currency={currency} className="text-left" />
        )}
      </div>
    </Link>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | undefined;
  hint?: string;
  href: string;
}) {
  return (
    <Link href={href} className="block">
      <Card className="transition-colors hover:bg-accent/40">
        <CardContent className="flex items-center gap-3 p-4">
          <div className="rounded-md bg-muted p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="tabular text-xl font-semibold leading-tight">{value ?? '-'}</div>
            {hint ? <div className="truncate text-xs text-muted-foreground">{hint}</div> : null}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
