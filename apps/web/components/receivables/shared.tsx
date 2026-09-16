'use client';
/* Building blocks shared by the receivables screens: KPI tiles, dependency-free charts, status badges, small dialogs. */
import * as React from 'react';
import { formatMoney } from '@accounting/money';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
  cn,
} from '@accounting/ui';
import { titleCase } from '@/lib/format';

// -------------------------------------------------------------------- tiles

export function Kpi({
  label,
  value,
  hint,
  tone,
  currency,
  raw,
}: {
  label: string;
  value: string | number;
  hint?: React.ReactNode;
  tone?: 'danger' | 'success' | 'warning';
  currency?: string;
  /** Show the value as given (percentages, labels) instead of formatting it as money. */
  raw?: boolean;
}) {
  const display =
    typeof value === 'number' ? value.toLocaleString() : raw ? value : formatMoney(value, currency);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div
          className={cn(
            'tabular text-xl font-semibold',
            tone === 'danger' && 'text-destructive',
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
          )}
        >
          {display}
        </div>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------- charts

const W = 640;
const H = 220;
const PAD = { l: 56, r: 12, t: 12, b: 28 };

function scale(values: number[]) {
  const max = Math.max(1, ...values);
  return { max, y: (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / max) };
}

function niceTicks(max: number, n = 4): number[] {
  const step = Math.pow(10, Math.floor(Math.log10(max / n)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * step);
  const s = candidates.find((c) => max / c <= n) ?? candidates[candidates.length - 1]!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += s) ticks.push(v);
  return ticks;
}

function short(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(Math.round(v));
}

/** Grouped bars per category (up to 2 series). */
export function BarChart({
  categories,
  series,
  title,
  description,
  format = short,
}: {
  categories: string[];
  series: Array<{ name: string; values: number[]; className?: string }>;
  title: string;
  description?: string;
  format?: (v: number) => string;
}) {
  const all = series.flatMap((s) => s.values);
  const { max, y } = scale(all);
  const ticks = niceTicks(max);
  const n = Math.max(1, categories.length);
  const slot = (W - PAD.l - PAD.r) / n;
  const barW = Math.min(36, (slot * 0.7) / series.length);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {all.every((v) => v === 0) ? (
          <p className="text-sm text-muted-foreground">No data yet.</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" role="img" aria-label={title}>
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.l}
                  x2={W - PAD.r}
                  y1={y(t)}
                  y2={y(t)}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={PAD.l - 6}
                  y={y(t) + 4}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px]"
                >
                  {format(t)}
                </text>
              </g>
            ))}
            {categories.map((c, i) => (
              <g key={c}>
                {series.map((s, j) => {
                  const v = s.values[i] ?? 0;
                  const x = PAD.l + slot * i + slot / 2 - (barW * series.length) / 2 + barW * j;
                  return (
                    <rect
                      key={s.name}
                      x={x}
                      y={y(v)}
                      width={barW - 2}
                      height={Math.max(0, H - PAD.b - y(v))}
                      className={s.className ?? (j === 0 ? 'fill-primary' : 'fill-primary/40')}
                      rx={2}
                    >
                      <title>{`${c} - ${s.name}: ${v.toLocaleString()}`}</title>
                    </rect>
                  );
                })}
                <text
                  x={PAD.l + slot * i + slot / 2}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px]"
                >
                  {c}
                </text>
              </g>
            ))}
          </svg>
        )}
        {series.length > 1 ? (
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            {series.map((s, j) => (
              <span key={s.name} className="flex items-center gap-1">
                <span
                  className={cn(
                    'inline-block h-2 w-3 rounded-sm',
                    s.className ?? (j === 0 ? 'bg-primary' : 'bg-primary/40'),
                  )}
                />
                {s.name}
              </span>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Line chart for one or two series over the same categories. */
export function LineChart({
  categories,
  series,
  title,
  description,
  format = short,
}: {
  categories: string[];
  series: Array<{ name: string; values: number[]; className?: string }>;
  title: string;
  description?: string;
  format?: (v: number) => string;
}) {
  const all = series.flatMap((s) => s.values);
  const { max, y } = scale(all);
  const ticks = niceTicks(max);
  const n = Math.max(1, categories.length);
  const x = (i: number) => PAD.l + (W - PAD.l - PAD.r) * (n === 1 ? 0.5 : i / (n - 1));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {all.every((v) => v === 0) ? (
          <p className="text-sm text-muted-foreground">No data yet.</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" role="img" aria-label={title}>
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.l}
                  x2={W - PAD.r}
                  y1={y(t)}
                  y2={y(t)}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={PAD.l - 6}
                  y={y(t) + 4}
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px]"
                >
                  {format(t)}
                </text>
              </g>
            ))}
            {series.map((s, j) => (
              <g key={s.name}>
                <path
                  d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')}
                  fill="none"
                  strokeWidth={2}
                  className={s.className ?? (j === 0 ? 'stroke-primary' : 'stroke-warning')}
                />
                {s.values.map((v, i) => (
                  <circle
                    key={i}
                    cx={x(i)}
                    cy={y(v)}
                    r={3}
                    className={
                      s.className?.replace('stroke', 'fill') ??
                      (j === 0 ? 'fill-primary' : 'fill-warning')
                    }
                  >
                    <title>{`${categories[i]} - ${s.name}: ${v.toLocaleString()}`}</title>
                  </circle>
                ))}
              </g>
            ))}
            {categories.map((c, i) => (
              <text
                key={c}
                x={x(i)}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {c}
              </text>
            ))}
          </svg>
        )}
        {series.length > 1 ? (
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            {series.map((s, j) => (
              <span key={s.name} className="flex items-center gap-1">
                <span
                  className={cn('inline-block h-0.5 w-4', j === 0 ? 'bg-primary' : 'bg-warning')}
                />
                {s.name}
              </span>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------- badges

type Variant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline';

const STATUS_TONE: Record<string, Variant> = {
  DRAFT: 'secondary',
  SUBMITTED: 'warning',
  APPROVED: 'default',
  CONFIRMED: 'default',
  POSTED: 'success',
  PAID: 'success',
  DELIVERED: 'success',
  RECEIVED: 'success',
  KEPT: 'success',
  COLLECTED: 'success',
  RESOLVED: 'success',
  RECOVERED: 'success',
  GOOD: 'success',
  PARTIALLY_PAID: 'warning',
  PENDING: 'warning',
  PICKING: 'warning',
  READY: 'warning',
  INVESTIGATING: 'warning',
  PROMISED: 'warning',
  CONTACTED: 'default',
  WARNING: 'warning',
  MEDIUM: 'warning',
  ESCALATED: 'destructive',
  DISPUTED: 'destructive',
  BROKEN: 'destructive',
  REJECTED: 'destructive',
  VOID: 'destructive',
  CANCELLED: 'destructive',
  ON_HOLD: 'destructive',
  OVER_LIMIT: 'destructive',
  HIGH: 'destructive',
  CRITICAL: 'destructive',
  OPEN: 'outline',
  NEW: 'outline',
  WRITTEN_OFF: 'outline',
  CLOSED: 'outline',
  REVERSED: 'outline',
  LOW: 'secondary',
  OK: 'success',
  SENT: 'warning',
  SETTLED: 'success',
  GENERATED: 'secondary',
  TRANSMITTED: 'warning',
  ACKNOWLEDGED: 'success',
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  INFLOW: 'success',
  OUTFLOW: 'outline',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant={STATUS_TONE[status] ?? 'secondary'} className={className}>
      {titleCase(status)}
    </Badge>
  );
}

// ------------------------------------------------------------------ dialogs

/** A dialog asking for a free-text reason / comment before running an action. */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label = 'Reason',
  confirmLabel = 'Confirm',
  destructive,
  loading,
  required = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label?: string;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  required?: boolean;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = React.useState('');
  React.useEffect(() => {
    if (!open) setReason('');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reason-dialog-input">{label}</Label>
          <Textarea
            id="reason-dialog-input"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={loading || (required && !reason.trim())}
            onClick={() => void onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function DescriptionList({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v ?? '-'}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
