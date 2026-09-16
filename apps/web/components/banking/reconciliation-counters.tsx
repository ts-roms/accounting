'use client';
import { Check, CircleAlert, Search } from 'lucide-react';
import { AnimatedNumber, AnimatedProgress, cn } from '@accounting/ui';

/**
 * Matched / needs review / unmatched counters for a bank statement. Values
 * tween when auto-matching completes so the change reads as a state change;
 * the progress bar reflects matched / total lines.
 */
export function ReconciliationCounters({
  matched,
  review,
  unmatched,
  total,
  className,
}: {
  matched: number;
  review: number;
  unmatched: number;
  total: number;
  className?: string;
}) {
  const pct = total ? (matched / total) * 100 : 0;
  return (
    <div className={cn('rounded-lg border bg-card p-4', className)} data-testid="recon-counters">
      <div className="grid grid-cols-3 gap-4">
        <Counter icon={Check} label="Matched" value={matched} tone="positive" />
        <Counter
          icon={Search}
          label="Needs review"
          value={review}
          tone={review ? 'warning' : 'neutral'}
        />
        <Counter
          icon={CircleAlert}
          label="Unmatched"
          value={unmatched}
          tone={unmatched ? 'critical' : 'neutral'}
        />
      </div>
      <AnimatedProgress
        value={pct}
        size="sm"
        tone={pct === 100 ? 'positive' : 'primary'}
        label="Matched lines"
        className="mt-3"
      />
      <div className="mt-1 text-xs text-muted-foreground tabular">
        {matched} of {total} lines matched
      </div>
    </div>
  );
}

const TONE = {
  positive: 'text-positive',
  warning: 'text-warning',
  critical: 'text-critical',
  neutral: 'text-muted-foreground',
} as const;

function Counter({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Check;
  label: string;
  value: number;
  tone: keyof typeof TONE;
}) {
  return (
    <div className="min-w-0">
      <div className="type-label inline-flex items-center gap-1.5">
        <Icon className={cn('size-3.5', TONE[tone])} aria-hidden />
        {label}
      </div>
      <AnimatedNumber
        value={value}
        duration="slow"
        className={cn('mt-1 block text-xl font-semibold', TONE[tone])}
      />
    </div>
  );
}
