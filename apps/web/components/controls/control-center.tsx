'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  BookOpenCheck,
  CalendarClock,
  ClipboardCheck,
  FileClock,
  Gauge,
  KeyRound,
  Landmark,
  RefreshCw,
  Scale,
  ShieldCheck,
  Users,
  Workflow,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, Input, Label, Skeleton } from '@accounting/ui';
import { formatMoney } from '@accounting/money';
import { P, type PermissionKey } from '@accounting/types';
import { describeError } from '@/lib/api/client';
import { useControlDashboard } from '@/lib/api/controls-hooks';
import type { ControlSeverity, ControlTile } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/auth/session';
import { PageHeader } from '@/components/ui-ext/page';
import { today } from '@/components/accounting/primitives';

const SEVERITY_VARIANT: Record<
  ControlSeverity,
  'success' | 'secondary' | 'warning' | 'destructive'
> = {
  OK: 'success',
  INFO: 'secondary',
  WARNING: 'warning',
  CRITICAL: 'destructive',
};

const SEVERITY_RING: Record<ControlSeverity, string> = {
  OK: 'border-l-success',
  INFO: 'border-l-muted-foreground/40',
  WARNING: 'border-l-warning',
  CRITICAL: 'border-l-destructive',
};

/** Central operational area for finance administrators (spec 53 / 54). */
const SECTIONS: Array<{
  title: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  permission: PermissionKey;
}> = [
  {
    title: 'Financial periods',
    description: 'Open, soft-close, close and lock periods.',
    href: '/accounting/period-closing',
    icon: CalendarClock,
    permission: P['period.view'],
  },
  {
    title: 'Financial close',
    description: 'Checklists, blockers and management approval.',
    href: '/accounting/financial-close',
    icon: ClipboardCheck,
    permission: P['close.view'],
  },
  {
    title: 'Reconciliation',
    description: 'Subledger-to-control and bank reconciliations.',
    href: '/accounting/reconciliation',
    icon: Scale,
    permission: P['reconciliation.view'],
  },
  {
    title: 'Integrity checks',
    description: 'Every accounting invariant, run against live data.',
    href: '/accounting/integrity',
    icon: ShieldCheck,
    permission: P['integrity.check'],
  },
  {
    title: 'Suspense accounts',
    description: 'Balances parked in suspense and clearing accounts.',
    href: '/accounting/suspense',
    icon: AlertTriangle,
    permission: P['controls.view'],
  },
  {
    title: 'Account mappings',
    description: 'Which accounts the posting rules resolve to.',
    href: '/accounting/chart-of-accounts',
    icon: BookOpenCheck,
    permission: P['account.view'],
  },
  {
    title: 'Approval workflows',
    description: 'Amount bands, steps, deadlines and escalation.',
    href: '/admin/workflows',
    icon: Workflow,
    permission: P['workflow.manage'],
  },
  {
    title: 'Approvals',
    description: 'Pending and overdue approval requests.',
    href: '/admin/approvals',
    icon: FileClock,
    permission: P['approval.view'],
  },
  {
    title: 'Roles & segregation of duties',
    description: 'Roles, permissions, SoD policies and conflicts.',
    href: '/admin/roles',
    icon: KeyRound,
    permission: P['role.view'],
  },
  {
    title: 'Users',
    description: 'Accounts, status and role assignments.',
    href: '/admin/users',
    icon: Users,
    permission: P['user.view'],
  },
  {
    title: 'Audit trail',
    description: 'Immutable record of every action.',
    href: '/admin/audit-logs',
    icon: Landmark,
    permission: P['audit.view'],
  },
  {
    title: 'Tax configuration',
    description: 'Tax codes, rates and accounts.',
    href: '/tax',
    icon: Gauge,
    permission: P['tax.view'],
  },
];

function TileValue({ tile, currency }: { tile: ControlTile; currency: string }) {
  if (tile.kind === 'amount')
    return <span className="tabular">{formatMoney(tile.value, currency)}</span>;
  if (tile.kind === 'percent') return <>{tile.value}%</>;
  return <>{tile.value}</>;
}

export function ControlCenterPage() {
  const [asOf, setAsOf] = React.useState(today());
  const dashboard = useControlDashboard(asOf);
  const session = useSession();
  const d = dashboard.data;
  return (
    <>
      <PageHeader
        title="Accounting Control Center"
        description="Financial integrity at a glance: unbalanced journals, approvals, reconciliation variances, suspense balances, exceptions, segregation of duties and the state of the close."
        actions={
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="controls-asof">As of</Label>
              <Input
                id="controls-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                data-testid="controls-asof"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void dashboard.refetch()}
              disabled={dashboard.isFetching}
              data-testid="controls-refresh"
            >
              <RefreshCw className={dashboard.isFetching ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        }
      />
      {dashboard.isError ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            {describeError(dashboard.error)}
          </CardContent>
        </Card>
      ) : !d ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Badge variant={SEVERITY_VARIANT[d.status]} data-testid="controls-status">
              {d.status}
            </Badge>
            <span>generated {formatDateTime(d.generatedAt)}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {d.tiles.map((tile) => (
              <Link key={tile.key} href={tile.href} className="block">
                <Card
                  className={`h-full border-l-4 transition-colors hover:bg-muted/40 ${SEVERITY_RING[tile.severity]}`}
                  data-testid="control-tile"
                  data-key={tile.key}
                  data-severity={tile.severity}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        {tile.title}
                      </div>
                      <Badge variant={SEVERITY_VARIANT[tile.severity]}>{tile.severity}</Badge>
                    </div>
                    <div className="mt-2 text-2xl font-semibold" data-testid="control-value">
                      <TileValue tile={tile} currency={d.currency} />
                    </div>
                    {tile.detail ? (
                      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {tile.detail}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Control areas</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {SECTIONS.filter((s) => session.hasPermission(s.permission)).map((s) => (
            <Link key={s.href} href={s.href} className="block" data-testid="control-section">
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardContent className="flex gap-3 p-4">
                  <s.icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div>
                    <div className="font-medium">{s.title}</div>
                    <div className="text-xs text-muted-foreground">{s.description}</div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
