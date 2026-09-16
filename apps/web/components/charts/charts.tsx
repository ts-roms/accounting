'use client';
/*
 * Minimal SVG charts for financial reporting. No charting library: the
 * dashboard needs a trend, a grouped bar and a donut, all in token colours
 * with a one-time draw-in (line: left-to-right; bars: grow up; donut: sweep)
 * over --motion-data. Charts never animate again unless the data changes.
 */
import * as React from 'react';
import { ChartSkeleton, cn, useReducedMotion } from '@accounting/ui';

export interface Series {
  key: string;
  label: string;
  /** Token colour, e.g. 'var(--chart-1)'. */
  color: string;
  values: number[];
}

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;
export const chartColor = (i: number) => CHART_COLORS[i % CHART_COLORS.length]!;

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * exp;
}

const compact = (v: number) =>
  new Intl.NumberFormat('en-PH', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

function useDrawIn(dep: unknown) {
  const reduced = useReducedMotion();
  const [drawn, setDrawn] = React.useState(reduced);
  React.useEffect(() => {
    if (reduced) {
      setDrawn(true);
      return;
    }
    setDrawn(false);
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setDrawn(true)));
    return () => cancelAnimationFrame(id);
  }, [dep, reduced]);
  return drawn;
}

export function Legend({
  series,
  className,
}: {
  series: Array<Pick<Series, 'key' | 'label' | 'color'>>;
  className?: string;
}) {
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground', className)}>
      {series.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-xs" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- line chart
export function LineChart({
  labels,
  series,
  height = 220,
  className,
  formatValue = compact,
  loading,
  ariaLabel = 'Line chart',
}: {
  labels: string[];
  series: Series[];
  height?: number;
  className?: string;
  formatValue?: (v: number) => string;
  loading?: boolean;
  ariaLabel?: string;
}) {
  const signature = series.map((s) => s.values.join(',')).join('|');
  const drawn = useDrawIn(signature);
  const gridId = React.useId();
  if (loading) return <ChartSkeleton className={className} />;
  const W = 720;
  const H = height;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  const max = niceMax(Math.max(0, ...all));
  const min = Math.min(0, ...all);
  const x = (i: number) => padL + (n <= 1 ? 0 : (i * (W - padL - padR)) / (n - 1));
  const y = (v: number) => padT + ((max - v) * (H - padT - padB)) / (max - min || 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t);

  return (
    <figure className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={ariaLabel}
        aria-describedby={gridId}
      >
        <desc id={gridId}>
          {series
            .map(
              (s) =>
                `${s.label}: ${s.values.map((v, i) => `${labels[i]} ${formatValue(v)}`).join(', ')}`,
            )
            .join('. ')}
        </desc>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeDasharray={t === 0 ? undefined : '2 4'}
            />
            <text
              x={padL - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[10px]"
            >
              {formatValue(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % Math.max(1, Math.ceil(n / 8)) === 0 || i === n - 1 ? (
            <text
              key={l + i}
              x={x(i)}
              y={H - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => {
          const d = s.values
            .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
            .join(' ');
          return (
            <g key={s.key}>
              <path
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                pathLength={1}
                style={{
                  strokeDasharray: 1,
                  strokeDashoffset: drawn ? 0 : 1,
                  transition: 'stroke-dashoffset var(--motion-data) var(--easing-out)',
                }}
              />
              {s.values.map((v, i) => (
                <circle
                  key={i}
                  cx={x(i)}
                  cy={y(v)}
                  r={2.5}
                  fill="var(--card)"
                  stroke={s.color}
                  strokeWidth={1.5}
                  style={{
                    opacity: drawn ? 1 : 0,
                    transition: `opacity var(--motion-normal) var(--easing-out) calc(var(--motion-data) * ${(i / Math.max(1, n - 1)).toFixed(2)})`,
                  }}
                >
                  <title>{`${s.label} · ${labels[i]}: ${formatValue(v)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <Legend series={series} className="mt-2" />
    </figure>
  );
}

// ----------------------------------------------------------------- bar chart
export function BarChart({
  labels,
  series,
  height = 200,
  className,
  formatValue = compact,
  loading,
  ariaLabel = 'Bar chart',
  stacked = false,
}: {
  labels: string[];
  series: Series[];
  height?: number;
  className?: string;
  formatValue?: (v: number) => string;
  loading?: boolean;
  ariaLabel?: string;
  stacked?: boolean;
}) {
  const signature = series.map((s) => s.values.join(',')).join('|');
  const drawn = useDrawIn(signature);
  if (loading) return <ChartSkeleton className={className} />;
  const W = 720;
  const H = height;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const n = labels.length;
  const totals = labels.map((_, i) =>
    stacked
      ? series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0)
      : Math.max(...series.map((s) => s.values[i] ?? 0)),
  );
  const max = niceMax(Math.max(0, ...totals));
  const slot = (W - padL - padR) / Math.max(1, n);
  const gap = slot * 0.25;
  const barW = stacked ? slot - gap : (slot - gap) / Math.max(1, series.length);
  const y = (v: number) => padT + ((max - v) * (H - padT - padB)) / (max || 1);
  const ticks = [0, 0.5, 1].map((t) => max * t);

  return (
    <figure className={cn('w-full', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeDasharray={t === 0 ? undefined : '2 4'}
            />
            <text
              x={padL - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[10px]"
            >
              {formatValue(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => {
          let acc = 0;
          return (
            <g key={l + i}>
              {series.map((s, si) => {
                const v = Math.max(0, s.values[i] ?? 0);
                const x0 = padL + i * slot + gap / 2 + (stacked ? 0 : si * barW);
                const top = stacked ? y(acc + v) : y(v);
                const h = y(0) - y(v);
                if (stacked) acc += v;
                return (
                  <rect
                    key={s.key}
                    x={x0}
                    y={top}
                    width={Math.max(1, barW - (stacked ? 0 : 2))}
                    height={Math.max(0, h)}
                    rx={2}
                    fill={s.color}
                    style={{
                      transformOrigin: `${x0}px ${y(0)}px`,
                      transform: drawn ? 'scaleY(1)' : 'scaleY(0)',
                      transition: `transform var(--motion-data) var(--easing-out) ${i * 20}ms`,
                    }}
                  >
                    <title>{`${s.label} · ${l}: ${formatValue(v)}`}</title>
                  </rect>
                );
              })}
              <text
                x={padL + i * slot + slot / 2}
                y={H - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {l}
              </text>
            </g>
          );
        })}
      </svg>
      {series.length > 1 ? <Legend series={series} className="mt-2" /> : null}
    </figure>
  );
}

// --------------------------------------------------------------- donut chart
export function DonutChart({
  segments,
  size = 140,
  thickness = 16,
  className,
  formatValue = compact,
  center,
  ariaLabel = 'Donut chart',
}: {
  segments: Array<{ key: string; label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
  className?: string;
  formatValue?: (v: number) => string;
  center?: React.ReactNode;
  ariaLabel?: string;
}) {
  const signature = segments.map((s) => s.value).join(',');
  const drawn = useDrawIn(signature);
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className={cn('flex items-center gap-4', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          role="img"
          aria-label={ariaLabel}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={thickness}
          />
          {segments.map((s, i) => {
            const frac = total ? Math.max(0, s.value) / total : 0;
            const dash = frac * c;
            const el = (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${drawn ? dash : 0} ${c}`}
                strokeDashoffset={-offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                style={{
                  transition: `stroke-dasharray var(--motion-data) var(--easing-out) ${i * 60}ms`,
                }}
              >
                <title>{`${s.label}: ${formatValue(s.value)}`}</title>
              </circle>
            );
            offset += dash;
            return el;
          })}
        </svg>
        {center ? (
          <div className="absolute inset-0 flex items-center justify-center text-center">
            {center}
          </div>
        ) : null}
      </div>
      <ul className="min-w-0 flex-1 space-y-1 text-xs">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-xs"
                style={{ background: s.color }}
                aria-hidden
              />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="tabular font-medium">{formatValue(s.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
