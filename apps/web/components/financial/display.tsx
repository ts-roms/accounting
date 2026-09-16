'use client';
/*
 * Financial display primitives. Numbers are decimal strings from the API;
 * nothing here does arithmetic beyond sign detection. Positive / negative
 * styling is always sign + tone, never colour alone.
 */
import * as React from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { formatMoney } from '@accounting/money';
import { AnimatedNumber, cn } from '@accounting/ui';

const SYMBOL_CACHE = new Map<string, string>();

/** Currency symbol for a code (₱ for PHP, $ for USD…); falls back to the code. */
export function currencySymbol(currency: string, locale = 'en-PH'): string {
  const key = `${locale}:${currency}`;
  const cached = SYMBOL_CACHE.get(key);
  if (cached) return cached;
  let symbol = currency;
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(1);
    const found = parts.find((p) => p.type === 'currency')?.value;
    // Intl uses the generic sign for unknown codes; the code itself is clearer.
    symbol = found && found !== '¤' ? found : currency;
  } catch {
    /* unknown currency: keep the code */
  }
  SYMBOL_CACHE.set(key, symbol);
  return symbol;
}

const isZero = (v: string) => /^-?0(\.0+)?$/.test(v);
const isNegative = (v: string) => v.startsWith('-') && !isZero(v);

export interface CurrencyDisplayProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: string;
  currency?: string;
  /**
   * table  - accounting style: parentheses for negatives, no symbol (default)
   * metric - dashboard style: ₱1,250,000.00 / -₱32,500.00
   */
  variant?: 'table' | 'metric';
  /** Prefix positives with "+" (variances, deltas). */
  signed?: boolean;
  /** Colour negatives critical / positives positive (default true for metric). */
  tone?: boolean;
  fractionDigits?: number;
  zeroAsDash?: boolean;
  /** Count up on mount (metric only). */
  animate?: boolean;
}

/** Tabular currency figure. Right-aligned in tables; metric variant for KPIs. */
export function CurrencyDisplay({
  value,
  currency = 'PHP',
  variant = 'table',
  signed = false,
  tone,
  fractionDigits = 2,
  zeroAsDash = false,
  animate = false,
  className,
  ...props
}: CurrencyDisplayProps) {
  const zero = isZero(value);
  const negative = isNegative(value);
  const toned = tone ?? variant === 'metric';
  const toneClass =
    !toned || zero ? '' : negative ? 'text-critical' : signed ? 'text-positive' : '';

  if (zero && zeroAsDash) {
    return (
      <span className={cn('tabular text-muted-foreground', className)} {...props}>
        -
      </span>
    );
  }

  if (variant === 'table') {
    return (
      <span
        className={cn(
          'tabular type-financial',
          zero && 'text-muted-foreground',
          toneClass,
          className,
        )}
        {...props}
      >
        {signed && !negative && !zero ? '+' : ''}
        {formatMoney(value, currency, { fractionDigits })}
      </span>
    );
  }

  const symbol = currencySymbol(currency);
  const magnitude = formatMoney(value.replace('-', ''), currency, { fractionDigits });
  const sign = negative ? '-' : signed && !zero ? '+' : '';
  const label = `${sign}${symbol}${magnitude}`;

  if (animate) {
    const numeric = Number(value);
    return (
      <AnimatedNumber
        value={Number.isFinite(numeric) ? numeric : 0}
        format={(v) => {
          const neg = v < 0;
          const abs = Math.abs(v).toFixed(fractionDigits);
          return `${neg ? '-' : signed && v > 0 ? '+' : ''}${symbol}${formatMoney(abs, currency, { fractionDigits })}`;
        }}
        className={cn('type-financial', zero && 'text-muted-foreground', toneClass, className)}
        {...props}
      />
    );
  }
  return (
    <span
      className={cn(
        'tabular type-financial',
        zero && 'text-muted-foreground',
        toneClass,
        className,
      )}
      {...props}
    >
      <span aria-hidden>
        {sign}
        <span className="mr-0.5 text-[0.85em] text-muted-foreground">{symbol}</span>
        {magnitude}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export interface PercentageDisplayProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Ratio as a number (0.124 = 12.4%) or a percent string ("12.4"). */
  value: number | string;
  asRatio?: boolean;
  fractionDigits?: number;
  signed?: boolean;
  tone?: boolean;
  animate?: boolean;
}

export function PercentageDisplay({
  value,
  asRatio = typeof value === 'number',
  fractionDigits = 1,
  signed = false,
  tone = false,
  animate = false,
  className,
  ...props
}: PercentageDisplayProps) {
  const n = typeof value === 'number' ? value : Number(value);
  const pct = asRatio ? n * 100 : n;
  const negative = pct < 0;
  const toneClass =
    !tone || pct === 0 ? '' : negative ? 'text-critical' : signed ? 'text-positive' : '';
  const fmt = (v: number) => `${v > 0 && signed ? '+' : ''}${v.toFixed(fractionDigits)}%`;
  if (animate) {
    return (
      <AnimatedNumber
        value={Number.isFinite(pct) ? pct : 0}
        format={fmt}
        className={cn('type-financial', toneClass, className)}
        {...props}
      />
    );
  }
  return (
    <span className={cn('tabular type-financial', toneClass, className)} {...props}>
      {Number.isFinite(pct) ? fmt(pct) : '-'}
    </span>
  );
}

/**
 * Change indicator: arrow + signed value. `direction` decides which sign is
 * "good" (an expense increase is not positive).
 */
export function DeltaIndicator({
  value,
  label,
  direction = 'up-is-good',
  format = (v) => `${Math.abs(v).toFixed(1)}%`,
  className,
}: {
  /** Signed change (percent points or ratio, formatter decides). */
  value: number | null | undefined;
  /** Comparison context, e.g. "vs last month". */
  label?: string;
  direction?: 'up-is-good' | 'down-is-good' | 'neutral';
  format?: (v: number) => string;
  className?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <span
        className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}
      >
        <Minus className="size-3" aria-hidden /> n/a
      </span>
    );
  }
  const up = value > 0;
  const flat = value === 0;
  const good = direction === 'neutral' ? null : direction === 'up-is-good' ? up : !up;
  const toneClass =
    flat || good === null ? 'text-muted-foreground' : good ? 'text-positive' : 'text-critical';
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium tabular',
        toneClass,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden strokeWidth={2.5} />
      <span>
        <span className="sr-only">{up ? 'Up' : flat ? 'Unchanged' : 'Down'} </span>
        {up ? '+' : flat ? '' : '-'}
        {format(value)}
      </span>
      {label ? <span className="font-normal text-muted-foreground">{label}</span> : null}
    </span>
  );
}

/** Monospace account code. */
export function AccountCode({
  code,
  name,
  className,
}: {
  code: string;
  name?: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-baseline gap-1.5', className)}>
      <span className="font-mono text-xs text-muted-foreground">{code}</span>
      {name ? <span className="truncate">{name}</span> : null}
    </span>
  );
}

/** Monospace document / transaction number (journal, invoice, payment). */
export function DocumentNumber({ value, className }: { value: string; className?: string }) {
  return <span className={cn('font-mono text-xs tracking-tight', className)}>{value}</span>;
}
