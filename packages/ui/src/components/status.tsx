'use client';
/*
 * Status language. Every status is colour + dot/icon + text so meaning never
 * depends on colour alone. Domain components (JournalStatus, PaymentStatus…)
 * map their enum to a `Tone` and render <StatusBadge>.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, Check, CircleAlert, Clock, Info, Loader2, Minus } from 'lucide-react';
import { cn } from '../lib/utils';
import { Badge } from './primitives';

export type Tone = 'positive' | 'warning' | 'critical' | 'info' | 'neutral' | 'pending';

/** Colour classes per tone (text / bg / border / solid). */
export const TONE = {
  positive: {
    text: 'text-positive',
    bg: 'bg-positive',
    soft: 'bg-positive/10',
    border: 'border-positive/30',
    icon: Check,
  },
  warning: {
    text: 'text-warning',
    bg: 'bg-warning',
    soft: 'bg-warning/10',
    border: 'border-warning/30',
    icon: AlertTriangle,
  },
  critical: {
    text: 'text-critical',
    bg: 'bg-critical',
    soft: 'bg-critical/10',
    border: 'border-critical/30',
    icon: CircleAlert,
  },
  info: {
    text: 'text-info',
    bg: 'bg-info',
    soft: 'bg-info/10',
    border: 'border-info/30',
    icon: Info,
  },
  neutral: {
    text: 'text-muted-foreground',
    bg: 'bg-neutral',
    soft: 'bg-muted',
    border: 'border-border',
    icon: Minus,
  },
  pending: {
    text: 'text-muted-foreground',
    bg: 'bg-neutral',
    soft: 'bg-muted',
    border: 'border-border',
    icon: Clock,
  },
} as const satisfies Record<
  Tone,
  { text: string; bg: string; soft: string; border: string; icon: LucideIcon }
>;

const BADGE_VARIANT: Record<Tone, 'positive' | 'warning' | 'critical' | 'info' | 'neutral'> = {
  positive: 'positive',
  warning: 'warning',
  critical: 'critical',
  info: 'info',
  neutral: 'neutral',
  pending: 'neutral',
};

/** Small coloured dot with a text alternative. */
export function StatusDot({
  tone,
  label,
  pulse = false,
  className,
}: {
  tone: Tone;
  label?: string;
  /** Subtle pulse for in-progress states only (syncing, running). */
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        TONE[tone].bg,
        pulse && 'animate-pulse',
        className,
      )}
    />
  );
}

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: Tone;
  /** Visible label. Rendered as-is; callers title-case enums. */
  children: React.ReactNode;
  /** Override the tone's default icon; `false` falls back to a dot. */
  icon?: LucideIcon | false;
  /** In-progress marker (spinner instead of icon). */
  active?: boolean;
  size?: 'sm' | 'md';
}

/**
 * Status badge: tone colour + icon (or dot) + text.
 * Usage: <StatusBadge tone="positive">Posted</StatusBadge>
 */
export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ tone, children, icon, active = false, size = 'md', className, ...props }, ref) => {
    const Icon = icon === false ? null : (icon ?? TONE[tone].icon);
    return (
      <Badge
        ref={ref}
        variant={BADGE_VARIANT[tone]}
        dot={Icon === null && !active}
        className={cn(size === 'sm' && 'px-1.5 py-0 text-[11px]', className)}
        data-tone={tone}
        {...props}
      >
        {active ? (
          <Loader2 className="size-3 animate-spin" aria-hidden />
        ) : Icon ? (
          <Icon className="size-3" aria-hidden strokeWidth={2.5} />
        ) : null}
        {children}
      </Badge>
    );
  },
);
StatusBadge.displayName = 'StatusBadge';

/**
 * Health indicator: a headline word with the tone's icon, for dashboards and
 * cards (`HEALTHY`, `ATTENTION`, `CRITICAL`).
 */
export function HealthIndicator({
  tone,
  label,
  description,
  className,
}: {
  tone: Tone;
  label: string;
  description?: React.ReactNode;
  className?: string;
}) {
  const Icon = TONE[tone].icon;
  return (
    <div className={cn('flex items-center gap-3', className)} data-tone={tone}>
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-md border',
          TONE[tone].soft,
          TONE[tone].border,
          TONE[tone].text,
        )}
        aria-hidden
      >
        <Icon className="size-4" strokeWidth={2.5} />
      </span>
      <div className="min-w-0">
        <div className={cn('type-h2 uppercase tracking-wide', TONE[tone].text)}>{label}</div>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
    </div>
  );
}
