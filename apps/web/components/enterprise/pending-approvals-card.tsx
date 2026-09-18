'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Inbox } from 'lucide-react';
import { P } from '@accounting/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  StatusBadge,
} from '@accounting/ui';
import { useApprovals } from '@/lib/api/enterprise-hooks';
import { useSession } from '@/lib/auth/session';
import { formatDateTime, titleCase } from '@/lib/format';
import { Amount } from '@/components/accounting/primitives';
import { ApprovalDialog } from '@/components/enterprise/workflows';

/**
 * Dashboard inbox: the workflow steps the signed-in user can decide right now
 * (`GET /approvals?mine=true`), with approve / reject in place. Eligibility
 * (permission, named approvers, self-approval, one decision per person) is
 * decided by the API; the card only shows what it returns.
 */
export function PendingApprovalsCard({ className }: { className?: string }) {
  const { activeCompany, hasPermission } = useSession();
  const enabled = hasPermission(P['approval.view']) && Boolean(activeCompany);
  const mine = useApprovals({ mine: true, page: 1, pageSize: 5 });
  const [open, setOpen] = React.useState<string | null>(null);
  if (!enabled) return null;
  const total = mine.data?.total ?? 0;
  const overdue = mine.data?.items.filter((r) => r.overdue).length ?? 0;
  return (
    <Card className={className} data-testid="pending-approvals-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Inbox className="size-4 text-subtle-foreground" aria-hidden />
            Pending your approval
          </CardTitle>
          <CardDescription>
            Workflow steps you can decide now
            {overdue > 0 ? ` · ${overdue} overdue` : ''}.
          </CardDescription>
        </div>
        {mine.data ? (
          <StatusBadge tone={total > 0 ? (overdue > 0 ? 'critical' : 'warning') : 'positive'}>
            {total}
          </StatusBadge>
        ) : (
          <Skeleton className="h-5 w-8" />
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        {mine.isLoading ? (
          <>
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </>
        ) : total === 0 ? (
          <p className="py-1 text-sm text-muted-foreground" data-testid="pending-approvals-empty">
            Nothing waiting on you. Requests appear here as soon as a workflow step needs your
            decision.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {mine.data!.items.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 py-1.5 text-sm"
                data-testid="pending-approval-row"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono">{r.documentNumber}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {titleCase(r.documentType)}
                    </span>
                    {r.overdue ? (
                      <StatusBadge tone="critical" size="sm">
                        Overdue
                      </StatusBadge>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.steps[r.currentStep]?.name ?? 'Step'} · {r.requestedByName ?? 'Unknown'} ·{' '}
                    {formatDateTime(r.createdAt)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Amount value={r.amount} currency={r.currency} className="text-sm" />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setOpen(r.id)}
                    data-testid="pending-approval-decide"
                  >
                    <Check /> Decide
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {total > 0 ? (
          <Button asChild variant="ghost" size="sm" className="mt-1 w-full justify-between">
            <Link href="/admin/approvals">
              View all {total > 5 ? `${total} requests` : 'requests'} <ArrowRight />
            </Link>
          </Button>
        ) : null}
      </CardContent>
      <ApprovalDialog id={open} onOpenChange={(o) => (o ? null : setOpen(null))} />
    </Card>
  );
}
