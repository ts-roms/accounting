'use client';
/*
 * Page-level building blocks: header, confirm dialog, permission gate, and
 * re-exports of the shared feedback states so existing imports keep working.
 */
import * as React from 'react';
import type { PermissionKey } from '@accounting/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from '@accounting/ui';
import { useSession } from '@/lib/auth/session';

export {
  EmptyState,
  ErrorState,
  SuccessState,
  TableSkeleton,
  CardSkeleton,
  FormSkeleton,
  ChartSkeleton,
  MetricSkeleton,
  DashboardSkeleton,
} from '@accounting/ui';

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Small label above the title (module / context). */
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0 space-y-0.5">
        {eyebrow ? <div className="type-label">{eyebrow}</div> : null}
        <h1 className="type-h1 flex flex-wrap items-center gap-2">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Confirmation for consequential actions. Destructive confirmations state the
 * consequence in the description and use the destructive button style.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  loadingLabel,
  destructive = false,
  loading = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  /** Label while the action runs, e.g. "Posting..." */
  loadingLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  /** Optional body (e.g. an OperationProgress) rendered between header and footer. */
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => (!o && loading ? undefined : onOpenChange(o))}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={() => void onConfirm()}
            loading={loading}
            loadingText={loadingLabel}
            autoFocus
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renders children only when the caller holds ALL listed permissions. UX only - the API is authoritative. */
export function Can({
  permissions,
  children,
  fallback = null,
}: {
  permissions: PermissionKey[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { hasPermission } = useSession();
  return <>{hasPermission(...permissions) ? children : fallback}</>;
}
