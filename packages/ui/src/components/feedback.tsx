'use client';
/*
 * Feedback states: empty, error, success, and layout-matching skeletons.
 * Skeletons approximate the final layout; spinners are reserved for buttons.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { Button } from './button';
import { Card, CardContent, CardHeader, Skeleton } from './primitives';
import { AnimatedCheck } from './motion';

// ------------------------------------------------------------- empty state
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed px-6 text-center',
        compact ? 'py-8' : 'py-12',
        className,
      )}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="type-h3">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------- error state
export interface ErrorStateProps {
  title?: string;
  description?: React.ReactNode;
  /** Error reference / code shown to the user for support (never a stack trace). */
  reference?: string;
  correlationId?: string;
  timestamp?: string | Date;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
  compact?: boolean;
}

export function ErrorState({
  title = 'Unable to load data',
  description = 'Something went wrong while retrieving the data.',
  reference,
  correlationId,
  timestamp,
  onRetry,
  retrying,
  className,
  compact = false,
}: ErrorStateProps) {
  const when =
    timestamp instanceof Date
      ? timestamp.toISOString()
      : typeof timestamp === 'string'
        ? timestamp
        : undefined;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-critical/30 bg-critical/5 px-6 text-center',
        compact ? 'py-8' : 'py-12',
        className,
      )}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-md bg-critical/10 text-critical">
        <CircleAlert className="size-5" aria-hidden />
      </span>
      <p className="type-h3">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {reference || correlationId || when ? (
        <dl className="mt-3 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-left font-mono text-[11px] text-muted-foreground">
          {reference ? (
            <>
              <dt>Ref</dt>
              <dd className="text-foreground">{reference}</dd>
            </>
          ) : null}
          {correlationId ? (
            <>
              <dt>Correlation</dt>
              <dd className="text-foreground">{correlationId}</dd>
            </>
          ) : null}
          {when ? (
            <>
              <dt>Time</dt>
              <dd className="text-foreground">{when}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry} loading={retrying}>
          <RefreshCw /> Retry
        </Button>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------- success state
export function SuccessState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn('flex flex-col items-center justify-center px-6 py-8 text-center', className)}
    >
      <AnimatedCheck className="mb-3" />
      <p className="type-h3 animate-enter fade-in slide-in-up-1">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground animate-enter fade-in slide-in-up-1">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

// --------------------------------------------------------------- skeletons
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2 p-3" aria-busy aria-label="Loading table">
      <div className="flex gap-3">
        {Array.from({ length: columns }).map((_, c) => (
          <Skeleton key={c} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-5 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Card className={className} aria-busy>
      <CardHeader>
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-48" />
      </CardHeader>
      <CardContent className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${88 - i * 12}%` }} />
        ))}
      </CardContent>
    </Card>
  );
}

export function MetricSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn('p-4', className)} aria-busy>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-6 w-36" />
      <Skeleton className="mt-2 h-3 w-16" />
    </Card>
  );
}

export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <div className="space-y-4" aria-busy aria-label="Loading form">
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <div className="flex justify-end gap-2 pt-2">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}

export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex h-56 items-end gap-2 px-2', className)} aria-busy>
      {[40, 65, 50, 80, 60, 90, 70, 55, 75, 85, 45, 65].map((h, i) => (
        <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-5" aria-busy aria-label="Loading dashboard">
      <div className="space-y-1">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-64" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricSkeleton key={i} />
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-3.5 w-40" />
        </CardHeader>
        <CardContent>
          <ChartSkeleton />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={4} />
      </div>
    </div>
  );
}
