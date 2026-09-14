'use client';
import * as React from 'react';
import { AI_FORECAST_METRICS, type AiForecastMetric } from '@accounting/types';
import { formatMoney } from '@accounting/money';
import {
  Card,
  CardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import { useAiForecast } from '@/lib/api/ai-hooks';
import { titleCase } from '@/lib/format';
import { PageHeader } from '@/components/ui-ext/page';
import { Amount } from '@/components/accounting/primitives';
import { Stat } from '@/components/fixed-assets/shared';
import { AdvisoryNote } from './shared';

const METRIC_LABEL: Record<AiForecastMetric, string> = {
  REVENUE: 'Revenue',
  EXPENSES: 'Expenses (incl. cost of sales)',
  NET_INCOME: 'Net income',
  CASH: 'Net cash movement',
};

export function AiForecastPage({ initialMetric }: { initialMetric?: string }) {
  const [metric, setMetric] = React.useState<AiForecastMetric>(
    (AI_FORECAST_METRICS as readonly string[]).includes(initialMetric ?? '')
      ? (initialMetric as AiForecastMetric)
      : 'REVENUE',
  );
  const [history, setHistory] = React.useState('12');
  const [horizon, setHorizon] = React.useState('6');
  const forecast = useAiForecast({ metric, history: Number(history), horizon: Number(horizon) });
  const f = forecast.data;
  const lastActual = f?.history[f.history.length - 1];
  const firstForecast = f?.forecast[0];
  return (
    <>
      <PageHeader
        title="Forecast"
        description="A statistical baseline from posted monthly activity - a starting point for planning, not a prediction."
        actions={
          <div className="flex items-end gap-2">
            <Select value={metric} onValueChange={(v) => setMetric(v as AiForecastMetric)}>
              <SelectTrigger className="w-56" data-testid="forecast-metric">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_FORECAST_METRICS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={history} onValueChange={setHistory}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['6', '12', '24', '36'].map((n) => (
                  <SelectItem key={n} value={n}>
                    {n} months history
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={horizon} onValueChange={setHorizon}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['3', '6', '12'].map((n) => (
                  <SelectItem key={n} value={n}>
                    {n} months ahead
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <AdvisoryNote />
      {forecast.isLoading || !f ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Stat
              label={`Last month (${lastActual?.period ?? '-'})`}
              value={lastActual ? formatMoney(lastActual.value, f.currency) : '-'}
            />
            <Stat
              label={`Next month (${firstForecast?.period ?? '-'})`}
              value={firstForecast ? formatMoney(firstForecast.value, f.currency) : '-'}
              hint={
                firstForecast
                  ? `${formatMoney(firstForecast.low, f.currency)} - ${formatMoney(firstForecast.high, f.currency)}`
                  : undefined
              }
            />
            <Stat
              label="Trend per month"
              value={formatMoney(f.slopePerMonth, f.currency)}
              hint={f.method}
            />
            <Stat
              label="Fit (R²)"
              value={f.r2.toFixed(2)}
              hint={
                f.r2 < 0.3
                  ? 'weak trend - treat with caution'
                  : f.r2 < 0.7
                    ? 'moderate trend'
                    : 'strong trend'
              }
            />
          </div>
          <Card>
            <CardContent className="p-4">
              <ForecastChart history={f.history} forecast={f.forecast} />
              <p className="mt-2 text-xs text-muted-foreground">{f.note}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead className="text-right">{titleCase(metric)}</TableHead>
                    <TableHead className="text-right">Low</TableHead>
                    <TableHead className="text-right">High</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {f.history.map((p) => (
                    <TableRow key={p.period}>
                      <TableCell className="font-mono text-xs">{p.period}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">actual</TableCell>
                      <TableCell>
                        <Amount value={p.value} currency={f.currency} />
                      </TableCell>
                      <TableCell />
                      <TableCell />
                    </TableRow>
                  ))}
                  {f.forecast.map((p) => (
                    <TableRow key={p.period} data-testid="forecast-row">
                      <TableCell className="font-mono text-xs">{p.period}</TableCell>
                      <TableCell className="text-xs text-primary">forecast</TableCell>
                      <TableCell>
                        <Amount value={p.value} currency={f.currency} className="font-medium" />
                      </TableCell>
                      <TableCell>
                        <Amount
                          value={p.low}
                          currency={f.currency}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                      <TableCell>
                        <Amount
                          value={p.high}
                          currency={f.currency}
                          className="text-muted-foreground"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}

/** Dependency-free line chart: actuals solid, forecast dashed with its band. */
function ForecastChart({
  history,
  forecast,
}: {
  history: { period: string; value: string }[];
  forecast: { period: string; value: string; low: string; high: string }[];
}) {
  const W = 800;
  const H = 220;
  const padX = 40;
  const padY = 20;
  const points = [
    ...history.map((p) => ({ ...p, low: p.value, high: p.value, kind: 'actual' as const })),
    ...forecast.map((p) => ({ ...p, kind: 'forecast' as const })),
  ];
  if (points.length < 2)
    return <p className="text-sm text-muted-foreground">Not enough history to chart.</p>;
  const values = points.flatMap((p) => [Number(p.value), Number(p.low), Number(p.high)]);
  const min = Math.min(0, ...values);
  const max = Math.max(...values, 1);
  const x = (i: number) => padX + (i * (W - padX * 2)) / (points.length - 1);
  const y = (v: number) => H - padY - ((v - min) * (H - padY * 2)) / (max - min || 1);
  const path = (sel: (p: (typeof points)[number]) => string, from: number, to: number) =>
    points
      .slice(from, to)
      .map(
        (p, i) => `${i === 0 ? 'M' : 'L'}${x(from + i).toFixed(1)},${y(Number(sel(p))).toFixed(1)}`,
      )
      .join(' ');
  const split = history.length - 1;
  const band =
    forecast.length > 0
      ? `${path((p) => p.high, split, points.length)} ${points
          .slice(split)
          .map(
            (p, i, arr) =>
              `L${x(split + arr.length - 1 - i).toFixed(1)},${y(Number(arr[arr.length - 1 - i]!.low)).toFixed(1)}`,
          )
          .join(' ')} Z`
      : '';
  const zeroY = y(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" role="img" aria-label="Forecast chart">
      <line
        x1={padX}
        x2={W - padX}
        y1={zeroY}
        y2={zeroY}
        className="stroke-border"
        strokeWidth={1}
      />
      {band ? <path d={band} className="fill-primary/10" /> : null}
      <path
        d={path((p) => p.value, 0, history.length)}
        className="fill-none stroke-foreground"
        strokeWidth={2}
      />
      {forecast.length ? (
        <path
          d={path((p) => p.value, split, points.length)}
          className="fill-none stroke-primary"
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      ) : null}
      {points.map((p, i) => (
        <g key={p.period}>
          <circle
            cx={x(i)}
            cy={y(Number(p.value))}
            r={3}
            className={p.kind === 'actual' ? 'fill-foreground' : 'fill-primary'}
          />
          {i % Math.max(1, Math.ceil(points.length / 12)) === 0 || i === points.length - 1 ? (
            <text
              x={x(i)}
              y={H - 4}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {p.period}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
