'use client';
/*
 * Motion utility layer.
 *
 * Principle: quiet motion that communicates state. Enter animations are CSS
 * keyframes driven by the motion tokens (so `prefers-reduced-motion` collapses
 * them in one place); value animation (counters, progress) is a small
 * requestAnimationFrame hook. No runtime animation library is required -
 * everything here is transform/opacity or a numeric tween.
 */
import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { MOTION_MS, readMotionMs, type MotionToken } from '../theme/motion';

// ---------------------------------------------------------- reduced motion
const QUERY = '(prefers-reduced-motion: reduce)';

/** True when the user asked for reduced motion. SSR-safe (defaults to false). */
export function useReducedMotion(): boolean {
  const subscribe = React.useCallback((cb: () => void) => {
    if (typeof window === 'undefined') return () => {};
    const mql = window.matchMedia(QUERY);
    mql.addEventListener('change', cb);
    return () => mql.removeEventListener('change', cb);
  }, []);
  return React.useSyncExternalStore(
    subscribe,
    () => (typeof window === 'undefined' ? false : window.matchMedia(QUERY).matches),
    () => false,
  );
}

// ---------------------------------------------------------------- wrappers
type RevealProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Delay in ms (use STAGGER_MS multiples; keep small). */
  delay?: number;
  duration?: MotionToken;
};

const DURATION_CLASS: Record<MotionToken, string> = {
  fast: 'animate-enter-fast',
  normal: 'animate-enter',
  medium: 'animate-enter-medium',
  slow: 'animate-enter-medium',
  data: 'animate-enter-medium',
};

function reveal(name: string, effect: string) {
  const C = React.forwardRef<HTMLDivElement, RevealProps>(
    ({ className, delay, duration = 'normal', style, ...props }, ref) => (
      <div
        ref={ref}
        className={cn(DURATION_CLASS[duration], effect, className)}
        style={delay ? { animationDelay: `${delay}ms`, ...style } : style}
        {...props}
      />
    ),
  );
  C.displayName = name;
  return C;
}

/** Opacity 0 -> 1. */
export const FadeIn = reveal('FadeIn', 'fade-in');
/** Opacity 0 -> 1 with a 4px rise. The default page-content entrance. */
export const SlideUp = reveal('SlideUp', 'fade-in slide-in-up-1');
/** Opacity 0 -> 1 with 98% -> 100% scale (cards, popovers, success marks). */
export const ScaleIn = reveal('ScaleIn', 'fade-in scale-in-98');

/**
 * Page entrance: re-runs the SlideUp when `routeKey` (usually the pathname)
 * changes. 150ms, 4px, ease-out - the user should barely notice it.
 */
export function PageTransition({
  routeKey,
  children,
  className,
}: {
  routeKey: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <SlideUp key={routeKey} className={cn('will-change-[opacity,transform]', className)}>
      {children}
    </SlideUp>
  );
}

// ------------------------------------------------------------- number tween
/**
 * Tweens a number toward `value` over the `data` motion token using an
 * ease-out curve. Returns the current display value. Honors reduced motion
 * (jumps immediately) and never re-animates unless `value` changes.
 */
export function useAnimatedValue(
  value: number,
  {
    duration = 'data',
    enabled = true,
    initial,
  }: { duration?: MotionToken; enabled?: boolean; initial?: number } = {},
): number {
  const reduced = useReducedMotion();
  const [display, setDisplay] = React.useState(initial ?? value);
  const fromRef = React.useRef(initial ?? value);
  const displayRef = React.useRef(initial ?? value);
  const frame = React.useRef<number | null>(null);

  React.useEffect(() => {
    const settle = () => {
      fromRef.current = value;
      displayRef.current = value;
      setDisplay(value);
    };
    if (!enabled || reduced) return settle();
    const ms = readMotionMs(duration);
    if (ms <= 0) return settle();
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = t >= 1 ? value : from + (value - from) * eased;
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      // Interrupted tween: continue from where the display actually is.
      fromRef.current = displayRef.current;
    };
  }, [value, duration, enabled, reduced]);

  return display;
}

export interface AnimatedNumberProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  /** Formats the tweened value for display (currency, percent, integer…). */
  format?: (value: number) => string;
  /** Set false to render statically (e.g. table cells, live feeds). */
  animate?: boolean;
  /** Count up from zero on first render (dashboard metrics). Default true. */
  animateOnMount?: boolean;
  duration?: MotionToken;
}

/**
 * Number that counts toward its value on first render / change. Exposes the
 * final value to assistive technology so screen readers never hear the tween.
 */
export function AnimatedNumber({
  value,
  format = (v) => Math.round(v).toLocaleString(),
  animate = true,
  animateOnMount = true,
  duration = 'data',
  className,
  ...props
}: AnimatedNumberProps) {
  const display = useAnimatedValue(value, {
    duration,
    enabled: animate,
    initial: animateOnMount ? 0 : undefined,
  });
  const final = format(value);
  return (
    <span className={cn('tabular', className)} aria-label={final} {...props}>
      <span aria-hidden>{display === value ? final : format(display)}</span>
    </span>
  );
}

/** Alias used by dashboards for integer counts. */
export const AnimatedCounter = AnimatedNumber;

// ----------------------------------------------------------------- progress
export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0-100. */
  value: number;
  tone?: 'primary' | 'positive' | 'warning' | 'critical';
  size?: 'sm' | 'md';
  label?: string;
  /** Animate width changes (default true; uses --motion-slow). */
  animate?: boolean;
}

const PROGRESS_TONE = {
  primary: 'bg-primary',
  positive: 'bg-positive',
  warning: 'bg-warning',
  critical: 'bg-critical',
} as const;

/** Determinate progress bar. Width transitions smoothly between values. */
export function AnimatedProgress({
  value,
  tone = 'primary',
  size = 'md',
  label,
  animate = true,
  className,
  ...props
}: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
      className={cn(
        'w-full overflow-hidden rounded-full bg-muted',
        size === 'sm' ? 'h-1' : 'h-1.5',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full',
          PROGRESS_TONE[tone],
          animate && 'transition-[width] duration-slow ease-out',
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
export const Progress = AnimatedProgress;

// ---------------------------------------------------------------- checkmark
/**
 * Success checkmark: circle scales 0.8 -> 1 with a fade over 200-300ms while
 * the stroke draws. Used by success states and completed operation steps.
 */
export function AnimatedCheck({
  size = 40,
  tone = 'positive',
  className,
  label = 'Completed',
}: {
  size?: number;
  tone?: 'positive' | 'primary';
  className?: string;
  label?: string;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full animate-enter-medium fade-in scale-in-80',
        tone === 'positive' ? 'bg-positive/15 text-positive' : 'bg-primary/15 text-primary',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Check
        className="animate-check-draw"
        style={{ width: size * 0.5, height: size * 0.5 }}
        strokeWidth={2.5}
        aria-hidden
      />
    </span>
  );
}

/**
 * Animates a status swap: the new child fades/scale in when `stateKey`
 * changes. Wrap a badge or icon; do not wrap large regions.
 */
export function AnimatedStatus({
  stateKey,
  children,
  className,
}: {
  stateKey: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <ScaleIn key={stateKey} duration="fast" className={cn('inline-flex', className)}>
      {children}
    </ScaleIn>
  );
}

export { MOTION_MS };
