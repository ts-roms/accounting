'use client';
import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowUpRight } from 'lucide-react';
import { Card, MetricSkeleton, cn } from '@accounting/ui';
import { CurrencyDisplay, DeltaIndicator } from './display';

export interface FinancialMetricCardProps {
  label: string;
  /** Decimal string from the API; undefined renders a skeleton. */
  value: string | undefined;
  currency?: string;
  /** Plain count instead of currency. */
  plain?: boolean;
  /** Signed change vs comparison period (percent points). */
  delta?: number | null;
  deltaLabel?: string;
  deltaDirection?: 'up-is-good' | 'down-is-good' | 'neutral';
  hint?: React.ReactNode;
  icon?: LucideIcon;
  href?: string;
  /** Error / empty message replacing the value. */
  message?: string;
  className?: string;
  /** Count up on first render (default true). */
  animate?: boolean;
  testId?: string;
}

/**
 * KPI tile. Value is the hero (tabular figures); delta and hint are quiet.
 * Metric tiles never fabricate: undefined shows a skeleton, `message` shows
 * why a figure is unavailable.
 */
export function FinancialMetricCard({
  label,
  value,
  currency = 'PHP',
  plain = false,
  delta,
  deltaLabel,
  deltaDirection = 'up-is-good',
  hint,
  icon: Icon,
  href,
  message,
  className,
  animate = true,
  testId,
}: FinancialMetricCardProps) {
  if (value === undefined && !message) return <MetricSkeleton className={className} />;

  const body = (
    <Card
      className={cn(
        'group relative flex h-full flex-col justify-between p-4 transition-[border-color,background-color] duration-fast',
        href && 'hover:border-border-strong hover:bg-accent/30',
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="type-label">{label}</div>
        {Icon ? <Icon className="size-4 text-subtle-foreground" aria-hidden /> : null}
        {href && !Icon ? (
          <ArrowUpRight
            className="size-4 text-subtle-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-2">
        {message ? (
          <div className="text-sm text-muted-foreground">{message}</div>
        ) : plain ? (
          <div className="type-display tabular">{value}</div>
        ) : (
          <CurrencyDisplay
            value={value ?? '0'}
            currency={currency}
            variant="metric"
            animate={animate}
            className="type-display"
          />
        )}
      </div>
      {(delta !== undefined || hint) && !message ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {delta !== undefined ? (
            <DeltaIndicator value={delta} label={deltaLabel} direction={deltaDirection} />
          ) : null}
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
      ) : null}
    </Card>
  );

  if (!href) return body;
  return (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {body}
    </Link>
  );
}
