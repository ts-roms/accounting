'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { P } from '@accounting/types';
import {
  AnimatedProgress,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  HealthIndicator,
  Skeleton,
  StatusBadge,
  type Tone,
  cn,
} from '@accounting/ui';
import { useSession } from '@/lib/auth/session';
import { useIntegrityReport } from '@/lib/api/accounting-hooks';
import { useReconciliationSummary } from '@/lib/api/reconciliation-hooks';
import { useCloses } from '@/lib/api/close-hooks';
import { today } from '@/components/accounting/primitives';
import { PercentageDisplay } from './display';

/**
 * Financial Health: derived only from live control data - the integrity
 * checker, the reconciliation center and the current financial close. There
 * is no invented "score": each row shows the real measure behind it, and the
 * headline is the worst tone among them.
 */
export function FinancialHealth({ className }: { className?: string }) {
  const { hasPermission, activeCompany } = useSession();
  const asOf = today();
  const canIntegrity = hasPermission(P['integrity.check']) && Boolean(activeCompany);
  const canRecon = hasPermission(P['reconciliation.view']) && Boolean(activeCompany);
  const canClose = hasPermission(P['close.view']) && Boolean(activeCompany);

  const integrity = useIntegrityReport(asOf, canIntegrity);
  const recon = useReconciliationSummary(asOf, canRecon);
  const closes = useCloses(
    { page: 1, pageSize: 1, sortBy: 'createdAt', sortDir: 'desc' },
    canClose,
  );

  if (!canIntegrity && !canRecon && !canClose) return null;

  // --- integrity
  const findings = integrity.data?.findings ?? [];
  const criticalFindings = findings.filter((f) => f.severity === 'CRITICAL');
  const warningFindings = findings.filter((f) => f.severity === 'WARNING');
  const integrityTone: Tone | undefined = integrity.data
    ? integrity.data.status === 'OK'
      ? 'positive'
      : integrity.data.status === 'WARNING'
        ? 'warning'
        : 'critical'
    : undefined;

  // --- reconciliation
  const areas = recon.data?.areas ?? [];
  const banks = recon.data?.banks ?? [];
  const within = areas.filter((a) => a.live.withinMateriality).length;
  const stale = areas.filter((a) => a.stale).length;
  const openExceptions =
    areas.reduce((n, a) => n + (a.latest?.openExceptions ?? 0), 0) +
    banks.reduce((n, b) => n + b.exceptions, 0);
  const reconRatio = areas.length ? within / areas.length : null;
  const reconTone: Tone | undefined = recon.data
    ? within === areas.length && openExceptions === 0
      ? stale > 0
        ? 'warning'
        : 'positive'
      : within < areas.length
        ? 'critical'
        : 'warning'
    : undefined;

  // --- close
  const close = closes.data?.items[0];
  const closeTone: Tone | undefined = closes.data
    ? !close
      ? 'neutral'
      : close.status === 'COMPLETED' || close.status === 'APPROVED'
        ? 'positive'
        : close.status === 'CANCELLED'
          ? 'neutral'
          : close.progress >= 80
            ? 'info'
            : 'warning'
    : undefined;

  // --- exceptions (critical integrity findings + open reconciliation exceptions)
  const exceptions = criticalFindings.reduce((n, f) => n + f.count, 0) + openExceptions;
  const exceptionsTone: Tone = exceptions === 0 ? 'positive' : 'critical';

  const tones = [integrityTone, reconTone, closeTone].filter(Boolean) as Tone[];
  const loading =
    (canIntegrity && integrity.isLoading) ||
    (canRecon && recon.isLoading) ||
    (canClose && closes.isLoading);
  const overall: { tone: Tone; label: string } =
    tones.includes('critical') || exceptions > 0
      ? { tone: 'critical', label: 'Critical' }
      : tones.includes('warning')
        ? { tone: 'warning', label: 'Attention' }
        : { tone: 'positive', label: 'Healthy' };

  return (
    <Card className={cn('flex flex-col', className)} data-testid="financial-health">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle>Financial health</CardTitle>
          <CardDescription>Live control indicators as of {asOf}.</CardDescription>
        </div>
        {loading ? (
          <Skeleton className="h-9 w-32" />
        ) : (
          <HealthIndicator tone={overall.tone} label={overall.label} />
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {canIntegrity ? (
          <HealthRow
            label="Accounting integrity"
            href="/accounting/integrity"
            tone={integrityTone}
            loading={integrity.isLoading}
            error={integrity.isError}
            value={
              integrity.data ? (
                <StatusBadge tone={integrityTone ?? 'neutral'} size="sm">
                  {integrity.data.status === 'OK'
                    ? 'All checks passed'
                    : `${criticalFindings.length} critical · ${warningFindings.length} warning`}
                </StatusBadge>
              ) : null
            }
          />
        ) : null}
        {canRecon ? (
          <HealthRow
            label="Reconciliation"
            href="/accounting/reconciliation"
            tone={reconTone}
            loading={recon.isLoading}
            error={recon.isError}
            value={
              recon.data ? (
                reconRatio === null ? (
                  <span className="text-xs text-muted-foreground">No control areas</span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <PercentageDisplay value={reconRatio} className="text-sm font-semibold" />
                    <span className="text-xs text-muted-foreground">
                      {within}/{areas.length} within materiality
                      {stale ? ` · ${stale} stale` : ''}
                    </span>
                  </span>
                )
              ) : null
            }
            progress={reconRatio === null ? undefined : reconRatio * 100}
          />
        ) : null}
        {canClose ? (
          <HealthRow
            label="Month-end close"
            href={close ? `/accounting/financial-close/${close.id}` : '/accounting/financial-close'}
            tone={closeTone}
            loading={closes.isLoading}
            error={closes.isError}
            value={
              closes.data ? (
                close ? (
                  <span className="inline-flex items-center gap-2">
                    <PercentageDisplay
                      value={close.progress}
                      asRatio={false}
                      fractionDigits={0}
                      className="text-sm font-semibold"
                    />
                    <span className="text-xs text-muted-foreground">
                      {close.periodName} · {close.doneCount}/{close.taskCount} tasks
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">No close started</span>
                )
              ) : null
            }
            progress={close ? close.progress : undefined}
          />
        ) : null}
        {canIntegrity || canRecon ? (
          <HealthRow
            label="Critical exceptions"
            href={exceptions > 0 ? '/accounting/reconciliation' : '/accounting/integrity'}
            tone={loading ? undefined : exceptionsTone}
            loading={loading}
            value={
              loading ? null : (
                <span
                  className={cn('tabular text-sm font-semibold', exceptions > 0 && 'text-critical')}
                >
                  {exceptions}
                </span>
              )
            }
          />
        ) : null}
      </CardContent>
      <div className="mt-auto border-t px-4 py-2">
        <Button variant="link" size="sm" asChild>
          <Link href="/accounting/financial-close">
            Open financial close <ArrowRight />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

const TONE_BAR: Record<Tone, 'positive' | 'warning' | 'critical' | 'primary'> = {
  positive: 'positive',
  warning: 'warning',
  critical: 'critical',
  info: 'primary',
  neutral: 'primary',
  pending: 'primary',
};

function HealthRow({
  label,
  href,
  tone,
  value,
  progress,
  loading,
  error,
}: {
  label: string;
  href: string;
  tone?: Tone;
  value: React.ReactNode;
  progress?: number;
  loading?: boolean;
  error?: boolean;
}) {
  return (
    <Link
      href={href}
      className="block rounded-sm px-1 py-1 transition-colors duration-fast hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
        {loading ? (
          <Skeleton className="h-4 w-28" />
        ) : error ? (
          <StatusBadge tone="warning" size="sm">
            Unavailable
          </StatusBadge>
        ) : (
          <span className="min-w-0 text-right">{value}</span>
        )}
      </div>
      {progress !== undefined && !loading && !error ? (
        <AnimatedProgress
          value={progress}
          size="sm"
          tone={tone ? TONE_BAR[tone] : 'primary'}
          label={`${label} progress`}
          className="mt-1.5"
        />
      ) : null}
    </Link>
  );
}
